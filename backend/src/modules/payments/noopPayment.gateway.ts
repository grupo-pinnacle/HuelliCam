import type { PaymentGateway, PaymentIntentInput, PaymentIntentResult } from './paymentGateway.interface';

export class NoopPaymentGateway implements PaymentGateway {
  public readonly providerName = 'SIMULATED_NOOP';

  public isLive(): boolean {
    return false;
  }

  public async createConsultationHold(input: PaymentIntentInput): Promise<PaymentIntentResult> {
    return {
      provider: this.providerName,
      externalRef: `sim-hold-${input.consultationId}`,
      status: 'SIMULATED',
      checkoutUrl: null,
    };
  }

  public async releaseVetPayout(consultationId: string): Promise<PaymentIntentResult> {
    return {
      provider: this.providerName,
      externalRef: `sim-payout-${consultationId}`,
      status: 'SIMULATED',
      checkoutUrl: null,
    };
  }
}
