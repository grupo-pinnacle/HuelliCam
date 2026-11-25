const path = require('path');

module.exports = {
  rootDir: __dirname,
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/backend/**/*.e2e.test.ts',
    '<rootDir>/scenarios/node/**/*.e2e.test.ts',
  ],
  setupFiles: ['<rootDir>/setup-node.ts'],
  moduleDirectories: [
    'node_modules',
    path.resolve(__dirname, '../../backend/node_modules'),
  ],
  moduleNameMapper: {
    '^@prisma/client$': path.resolve(
      __dirname,
      '../../backend/node_modules/@prisma/client'
    ),
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: path.resolve(__dirname, 'tsconfig.json'),
        diagnostics: false,
      },
    ],
  },
  forceExit: false,
  testTimeout: 30000,
  clearMocks: true,
};
