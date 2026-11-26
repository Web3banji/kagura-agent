/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    outputFileTracingIncludes: {
      '/*': ['./.next/server/app/**/page_client-reference-manifest.js'],
    },
  },
};

export default nextConfig;
