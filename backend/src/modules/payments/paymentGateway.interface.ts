export interface PaymentIntentInput {
  consultationId: string;
  amountCents: number;
  currency: string;
  payerEmail?: string;
}

export interface PaymentIntentResult {
  provider: string;
  externalRef: string;
  status: 'SIMULATED' | 'PENDING_PAYOUT' | 'SETTLED';
  checkoutUrl?: string | null;
}

export interface PaymentGateway {
  readonly providerName: string;
  isLive(): boolean;
  createConsultationHold(input: PaymentIntentInput): Promise<PaymentIntentResult>;
  releaseVetPayout(consultationId: string): Promise<PaymentIntentResult>;
}
