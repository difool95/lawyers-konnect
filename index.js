require('dotenv').config(); // Load .env variables at the very top

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
// const serviceAccount = require("./service-account.json");


// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount)
// });

if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(json)),
  });
} else {
  admin.initializeApp();
}

const db = admin.firestore();
/*
async function seedPlans() {
  const plans = [
    {
      name: 'Starter 500',
      conversations_count: 500,
      amount: 5000,
    },
    {
      name: 'Pro 1000',
      conversations_count: 1000,
      amount: 10000,
    },
    {
      name: 'Elite 5000',
      conversations_count: 5000,
      amount: 45000,
    }
  ];

  const batch = db.batch();
  plans.forEach(plan => {
    const ref = db.collection('plans').doc(); // auto-generated ID
    batch.set(ref, plan);
  });

  await batch.commit();
  console.log('Plans added to Firestore');
}

seedPlans().catch(console.error);
*/

const app = express();
app.use(cors());
app.use(bodyParser.json());

const KONNECT_API_URL = process.env.KONNECT_API_URL;
const KONNECT_API_KEY = process.env.KONNECT_API_KEY;
const KONNECT_WALLET = process.env.KONNECT_WALLET
const FRONTEND_URL = process.env.FRONTEND_URL

if (!KONNECT_API_URL || !KONNECT_API_KEY || !KONNECT_WALLET) {
  console.error('Missing KONNECT_API_URL or KONNECT_API_KEY or KONNECT_WALLET in .env');
  process.exit(1);
}

const konnectHeaders = {
  'x-api-key': `${KONNECT_API_KEY}`,
  'Content-Type': 'application/json'
};

console.log('HEADERS', konnectHeaders)

app.get('/plans', async (req, res) => {
  try {
    const snapshot = await db.collection('plans').get();
    const plans = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.status(200).json(plans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

app.post('/init-payment', async (req, res) => {
  try {
    const {
      planId,
      firstName,
      lastName,
      email,
      phoneNumber,
    } = req.body;
    const orderId = uuidv4();

    const planRef = db.collection('plans').doc(planId);
    const planSnap = await planRef.get();

    if (!planSnap.exists) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const plan = planSnap.data();

    const payload = {
      receiverWalletId: KONNECT_WALLET,
      token: 'TND',
      amount: plan.amount,
      type: 'immediate',
      description: `Purchase: ${plan.name}`,
      acceptedPaymentMethods: ['wallet', 'bank_card', 'e-DINAR'],
      lifespan: 10,
      checkoutForm: true,
      addPaymentFeesToAmount: true,
      firstName,
      lastName,
      phoneNumber,
      email,
      orderId,
      webhook: `${FRONTEND_URL}/verify-payment`,
      theme: 'dark'
    };

    const response = await axios.post(`${KONNECT_API_URL}/init-payment`, payload, { headers: konnectHeaders });

    const konnectPayment = response.data;

    const paymentDoc = {
      paymentRef: konnectPayment.paymentRef || konnectPayment.payment_id || null, // depends on API naming
      orderId: orderId || null,
      email: email || null,
      amount: plan.amount,
      planId: planId,
      conversations_count: plan.conversations_count,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      konnectResponse: konnectPayment
    };

    await db.collection('payments').add(paymentDoc);
    return res.json({
      message: 'Payment initiated',
      details: response.data,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

app.post('/verify-payment', async (req, res) => {
  try {
    const { paymentRef } = req.body;

    if (!paymentRef) {
      return res.status(400).json({ error: 'paymentRef is required' });
    }
    const paymentsRef = db.collection('payments');
    const snapshot = await paymentsRef.where('paymentRef', '==', paymentRef).limit(1).get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'Payment not found in Firestore' });
    }

    const paymentDoc = snapshot.docs[0];
    const paymentData = paymentDoc.data();

    if (paymentData.status === 'completed') {
      return res.status(200).json({ message: 'Payment already processed' });
    }
    const response = await axios.get(`${KONNECT_API_URL}/${paymentRef}`, { headers: konnectHeaders });

    const konnectPayment = response.data.payment;
    const isCompleted = konnectPayment.status === 'completed';
    const isSuccess = konnectPayment.transactions?.[0]?.status === 'success';

    if (isCompleted && isSuccess) {
      const planId = paymentData.planId;
      const planSnap = await db.collection('plans').doc(planId).get();

      if (!planSnap.exists) {
        return res.status(404).json({ error: 'Associated plan not found' });
      }

      const plan = planSnap.data();

      const userEmail = konnectPayment.paymentDetails?.email;

      if (!userEmail) {
        return res.status(400).json({ error: 'No email found in payment details' });
      }

      // Find user by email
      const usersRef = db.collection('users');
      const userSnapshot = await usersRef.where('email', '==', userEmail).limit(1).get();

      if (userSnapshot.empty) {
        return res.status(404).json({ error: 'User not found in Firestore' });
      }

      const userDoc = userSnapshot.docs[0];

      // Update user's conversations_count
      await userDoc.ref.update({
        conversation_count: admin.firestore.FieldValue.increment(plan.conversations_count),
      });

      // Update payment status in Firestore
      await paymentDoc.ref.update({
        status: 'completed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        konnectStatus: konnectPayment.status,
        konnectVerifiedAt: new Date().toISOString(),
      });

      return res.status(200).json({
        message: 'Payment verified, user updated, and status marked completed',
        paymentStatus: konnectPayment.status
      });
    } else {
      return res.status(200).json({
        message: 'Payment not completed or failed',
        paymentStatus: konnectPayment.status,
        transactionStatus: konnectPayment.transactions?.[0]?.status
      });
    }
  } catch (error) {
    console.error(error.response?.data || error.message);
    return res.status(500).json({ error: 'Failed to verify payment' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Konnect payment service running on port ${PORT}`);
});
