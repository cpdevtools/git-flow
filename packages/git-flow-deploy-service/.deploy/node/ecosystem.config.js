module.exports = {
  apps: [
    {
      name: 'git-flow-deploy-service',
      script: 'dist/main.js',
      // Fork mode (not cluster): a single instance where the app process itself
      // binds the port. In cluster mode the pm2 God daemon owns the listening
      // socket, so `pm2 stop`/`pm2 delete` frees the worker but NOT the port —
      // which blocks a mode change (e.g. node -> compose) from re-binding it.
      exec_mode: 'fork',
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
