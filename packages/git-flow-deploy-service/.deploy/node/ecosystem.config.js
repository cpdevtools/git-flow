module.exports = {
  apps: [
    {
      name: 'git-flow-deploy-service',
      script: 'dist/main.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3700,
      },
    },
  ],
};
