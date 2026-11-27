import type { PaymentGateway, PaymentIntentInput, PaymentIntentResult } from './paymentGateway.interface';

/**
 * Decoupled PagoFlex adapter stub.
 * Real wallet checkout/settlement stays disabled until PagoFlex credentials and commercial agreement are activated.
 */
export class PagoFlexGatewayStub implements PaymentGateway {
  public readonly providerName = 'PAGOFLEX_STUB';

  public isLive(): boolean {
    return false;
  }

  public async createConsultationHold(input: PaymentIntentInput): Promise<PaymentIntentResult> {
    return {
      provider: this.providerName,
      externalRef: `pagoflex-pending-${input.consultationId}`,
      status: 'SIMULATED',
      checkoutUrl: null,
    };
  }

  public async releaseVetPayout(consultationId: string): Promise<PaymentIntentResult> {
    return {
      provider: this.providerName,
      externalRef: `pagoflex-payout-stub-${consultationId}`,
      status: 'SIMULATED',
      checkoutUrl: null,
    };
  }
}
