/** @type {import('jest').Config} */
module.exports = {
  transform: { "\\.(js|ts)$": "@sucrase/jest-plugin" },
  testEnvironment: "node",
};
