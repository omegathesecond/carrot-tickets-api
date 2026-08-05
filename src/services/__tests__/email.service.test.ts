import { EmailService } from '@services/email.service';
import { YeboLinkClient } from '@services/yebolink.client';

jest.mock('@services/yebolink.client');

describe('EmailService.sendOtp', () => {
  const send = YeboLinkClient.sendEmail as jest.Mock;
  beforeEach(() => send.mockReset());

  it('sends the code and returns true on success', async () => {
    send.mockResolvedValue({ messageId: 'm1', status: 'queued' });
    const ok = await EmailService.sendOtp('buyer@example.com', '123456');
    expect(ok).toBe(true);
    const [to, subject, html] = send.mock.calls[0];
    expect(to).toBe('buyer@example.com');
    expect(subject).toMatch(/code/i);
    expect(html).toContain('123456');
  });

  it('returns false when YeboLink throws (caller surfaces the failure)', async () => {
    send.mockRejectedValue(new Error('YeboLink email send failed'));
    const ok = await EmailService.sendOtp('buyer@example.com', '123456');
    expect(ok).toBe(false);
  });
});
