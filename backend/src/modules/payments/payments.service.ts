import { LedgerEntryStatus, Role, User } from '@prisma/client';
import prisma, { isMissingTableError } from '../../lib/prisma';
import { AppError } from '../../middlewares/errorHandler';
import { NoopPaymentGateway } from './noopPayment.gateway';
import { PagoFlexGatewayStub } from './pagoFlex.gateway.stub';
import type { PaymentGateway } from './paymentGateway.interface';

export class PaymentsService {
  private readonly gateway: PaymentGateway;

  constructor() {
    this.gateway =
      process.env.PAYMENT_GATEWAY_PROVIDER === 'PAGOFLEX'
        ? new PagoFlexGatewayStub()
        : new NoopPaymentGateway();
  }

  public getGateway(): PaymentGateway {
    return this.gateway;
  }

  private async getPricing() {
    const fallback = {
      baseConsultationFee: 15000,
      platformTakeRate: 0.2,
      currency: 'ARS',
    };
    if (!prisma.platformPricingSetting?.findUnique) {
      return fallback;
    }
    const row = await prisma.platformPricingSetting
      .findUnique({ where: { id: 'default' } })
      .catch(() => null);
    if (!row) return fallback;
    return {
      baseConsultationFee: row.baseConsultationFee,
      platformTakeRate: row.platformTakeRate,
      currency: row.currency,
    };
  }

  public async recordSimulatedCompletionEntry(consultationId: string, vetId: string | null | undefined) {
    if (!vetId || !prisma.vetLedgerEntry?.upsert) return null;

    const pricing = await this.getPricing();
    const grossAmount = Math.max(0, Math.round(pricing.baseConsultationFee));
    const platformFee = Math.round(grossAmount * pricing.platformTakeRate);
    const vetNetAmount = Math.max(0, grossAmount - platformFee);

    if (prisma.consultationMetadata?.upsert) {
      await prisma.consultationMetadata
        .upsert({
          where: { consultationId },
          create: {
            consultationId,
            feeSnapshot: grossAmount,
            takeRateSnapshot: pricing.platformTakeRate,
            currencySnapshot: pricing.currency,
          },
          update: {
            feeSnapshot: grossAmount,
            takeRateSnapshot: pricing.platformTakeRate,
            currencySnapshot: pricing.currency,
          },
        })
        .catch(() => {});
    }

    const release = await this.gateway.releaseVetPayout(consultationId);

    return prisma.vetLedgerEntry.upsert({
      where: { consultationId },
      create: {
        consultationId,
        vetId,
        grossAmount,
        platformFee,
        vetNetAmount,
        currency: pricing.currency,
        status: LedgerEntryStatus.SIMULATED,
        externalProvider: release.provider,
        externalRef: release.externalRef,
      },
      update: {},
    });
  }

  public async getVetEarningsSummary(requester: User) {
    if (requester.role !== Role.VET && requester.role !== Role.ADMIN) {
      throw new AppError('Solo veterinarios pueden consultar liquidaciones', 403, 'FORBIDDEN');
    }

    const entries = prisma.vetLedgerEntry?.findMany
      ? await prisma.vetLedgerEntry
          .findMany({
            where: { vetId: requester.id },
            orderBy: { createdAt: 'desc' },
            take: 50,
          })
          .catch((err) => {
            if (isMissingTableError(err)) return [];
            throw err;
          })
      : [];

    const pricing = await this.getPricing();
    let totalGrossCents = 0;
    let totalFeeCents = 0;
    let totalNetCents = 0;

    for (const entry of entries) {
      totalGrossCents += entry.grossAmount;
      totalFeeCents += entry.platformFee;
      totalNetCents += entry.vetNetAmount;
    }

    return {
      totalGrossCents,
      totalFeeCents,
      totalNetCents,
      currency: entries[0]?.currency || pricing.currency,
      mode: this.gateway.isLive() ? 'LIVE' : 'SIMULATED_PAGOFLEX_PREP',
      entries: entries.map((e) => ({
        id: e.id,
        consultationId: e.consultationId,
        grossCents: e.grossAmount,
        platformFeeCents: e.platformFee,
        netCents: e.vetNetAmount,
        currency: e.currency,
        status: e.status,
        provider: e.externalProvider || this.gateway.providerName,
        settledAt: null,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }
}

export const paymentsService = new PaymentsService();
