import * as serverModule from '../server';
import prisma from '../lib/prisma';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock('../realtime/socket.server', () => ({
  initializeSocketServer: jest.fn().mockReturnValue({
    close: jest.fn(),
  }),
}));

describe('Database Schema Governance & Startup Stability', () => {
  it('should not expose ensureDatabaseSchema or execute dynamic runtime DDL', () => {
    expect((serverModule as any).ensureDatabaseSchema).toBeUndefined();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

