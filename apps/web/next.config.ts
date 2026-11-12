import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@agpal/shared'],
  poweredByHeader: false,
};

export default config;
