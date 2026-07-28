/**
 * Mock SMS Service for the MVP.
 * Logs SMS messages to the console instead of sending real ones.
 */

export async function sendMockSms(phone: string, message: string): Promise<void> {
  // In a real app, this would use Twilio, SNS, or a local provider API.
  console.log(`\n======================================================`);
  console.log(`📱 MOCK SMS DISPATCHED`);
  console.log(`To: ${phone}`);
  console.log(`Message: ${message}`);
  console.log(`======================================================\n`);
}
