// Plain Node environment (real network), used only for the contract check against a throwaway server.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/contract.test.ts'],
  transform: { '^.+\\.[jt]sx?$': ['babel-jest', { presets: ['babel-preset-expo'] }] },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
};
