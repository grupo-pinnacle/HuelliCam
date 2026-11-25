import { passwordResetService } from '../modules/auth/passwordReset.service';
import prisma from '../lib/prisma';
import bcrypt from 'bcryptjs';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    passwordResetToken: {
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

jest.mock('../services/email.service', () => ({
  emailService: {
    sendPasswordResetCode: jest.fn().mockResolvedValue(true),
  },
}));

const mockPrismaUser = prisma.user as jest.Mocked<typeof prisma.user>;
const mockPrismaToken = prisma.passwordResetToken as jest.Mocked<typeof prisma.passwordResetToken>;

describe('VULN-03: Password Reset Hardening & Rate Limiting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('requestReset TTL & Email Rate Limit', () => {
    it('should generate token with TTL <= 10 minutes (600,000 ms)', async () => {
      mockPrismaUser.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        firstName: 'John',
        deletedAt: null,
      } as any);
      mockPrismaToken.count.mockResolvedValue(0);
      mockPrismaToken.updateMany.mockResolvedValue({ count: 0 });
      mockPrismaToken.create.mockResolvedValue({ id: 'token-1' } as any);

      const before = Date.now();
      await passwordResetService.requestReset('user@example.com');
      const after = Date.now();

      expect(mockPrismaToken.create).toHaveBeenCalled();
      const createArgs = mockPrismaToken.create.mock.calls[0][0];
      const expiresAt = new Date(createArgs.data.expiresAt).getTime();

      // TTL should be exactly 10 minutes (with small execution buffer)
      expect(expiresAt - before).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
      expect(expiresAt - after).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000);
    });

    it('should reject with 429 TOO_MANY_REQUESTS when email exceeds 5 requests within 15 minutes', async () => {
      mockPrismaUser.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        firstName: 'John',
        deletedAt: null,
      } as any);
      mockPrismaToken.count.mockResolvedValue(5); // 5 prior requests

      await expect(passwordResetService.requestReset('user@example.com')).rejects.toMatchObject({
        statusCode: 429,
        code: 'TOO_MANY_REQUESTS',
      });
      expect(mockPrismaToken.create).not.toHaveBeenCalled();
    });
  });

  describe('verifyCode 3-Attempt Invalidation', () => {
    it('should invalidate token on 3rd failed attempt and mark usedAt', async () => {
      const activeToken = {
        id: 'token-attempt-test',
        email: 'victim@example.com',
        codeHash: await bcrypt.hash('123456', 10),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        usedAt: null,
      };

      mockPrismaToken.findFirst.mockResolvedValue(activeToken as any);
      mockPrismaToken.updateMany.mockResolvedValue({ count: 1 });

      // Attempt 1: Failed
      await expect(passwordResetService.verifyCode('victim@example.com', '999991')).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_RESET_CODE',
      });
      expect(mockPrismaToken.updateMany).not.toHaveBeenCalled();

      // Attempt 2: Failed
      await expect(passwordResetService.verifyCode('victim@example.com', '999992')).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_RESET_CODE',
      });
      expect(mockPrismaToken.updateMany).not.toHaveBeenCalled();

      // Attempt 3: Failed -> MUST invalidate token
      await expect(passwordResetService.verifyCode('victim@example.com', '999993')).rejects.toMatchObject({
        statusCode: 400,
        code: 'MAX_ATTEMPTS_EXCEEDED',
      });
      expect(mockPrismaToken.updateMany).toHaveBeenCalledWith({
        where: { id: activeToken.id, usedAt: null },
        data: expect.objectContaining({ usedAt: expect.any(Date) }),
      });
    });

    it('should succeed with valid code and reset attempt counter', async () => {
      const activeToken = {
        id: 'token-success-test',
        email: 'valid@example.com',
        codeHash: await bcrypt.hash('654321', 10),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        usedAt: null,
      };

      mockPrismaToken.findFirst.mockResolvedValue(activeToken as any);

      const result = await passwordResetService.verifyCode('valid@example.com', '654321');
      expect(result).toBe(true);
    });
  });
});
