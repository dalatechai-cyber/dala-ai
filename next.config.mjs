/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The webhook and worker routes read the RAW request body to verify HMAC
  // signatures. Nothing may parse or re-encode it in between.
  experimental: { serverMinification: false },
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
