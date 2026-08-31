// Returns the VAPID public key for push subscription.
// Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Vercel env vars (generate below).
export default function handler(req, res) {
  res.status(200).send(process.env.VAPID_PUBLIC_KEY || '');
}
