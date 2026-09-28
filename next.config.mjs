/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The webhook and worker routes read the RAW request body to verify HMAC
  // signatures. Nothing may parse or re-encode it in between.
  experimental: { serverMinification: false },
  // The short pay address (D-156, 0070): `pay.dalatech.online/DT-202610-0001-K7QM2X` is the
  // same page as `/pay/DT-202610-0001-K7QM2X`. Only when BILLING_PAY_ORIGIN names that host
  // (set it once its DNS points here), and only for an invoice-shaped path; the bare host
  // goes to dalatech.online.
  rewrites: async () => {
    const pay = process.env.BILLING_PAY_ORIGIN;
    if (!pay) return [];
    const host = new URL(pay).host;
    return {
      beforeFiles: [
        { source: '/:ref((?:TEST|DT|test|dt)-[0-9]{6}-[0-9]{4,9}-[0-9A-Za-z]{6})', has: [{ type: 'host', value: host }], destination: '/pay/:ref' },
      ],
    };
  },
  redirects: async () => {
    const pay = process.env.BILLING_PAY_ORIGIN;
    if (!pay) return [];
    return [{ source: '/', has: [{ type: 'host', value: new URL(pay).host }], destination: 'https://dalatech.online', permanent: false }];
  },
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    },
  ],
};
export default nextConfig;
