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

describe('EmailService.sendTicketConfirmation', () => {
  const send = YeboLinkClient.sendEmail as jest.Mock;
  beforeEach(() => send.mockReset());

  const tickets = [
    {
      ticketId: 'ABCD2345',
      eventName: 'Summer Bash',
      eventDate: '2026-09-01T18:00:00.000Z',
      venue: 'Mbabane Grounds',
    },
  ];

  it('sends the receipt and returns true on success', async () => {
    send.mockResolvedValue({ messageId: 'm1', status: 'queued' });
    const ok = await EmailService.sendTicketConfirmation('buyer@example.com', tickets);
    expect(ok).toBe(true);
    const [to, subject, html, fromName] = send.mock.calls[0];
    expect(to).toBe('buyer@example.com');
    expect(subject).toContain('Summer Bash');
    expect(html).toContain('Summer Bash');
    expect(html).toContain('Mbabane Grounds');
    expect(html).toContain('ABCD-2345'); // groupTicketCode display format
    expect(fromName).toBe('Carrot Tickets');
  });

  it('lists every ticket code for a multi-ticket purchase', async () => {
    send.mockResolvedValue({ messageId: 'm1', status: 'queued' });
    const multi = [
      ...tickets,
      { ...tickets[0]!, ticketId: 'WXYZ6789' },
    ];
    await EmailService.sendTicketConfirmation('buyer@example.com', multi);
    const html = send.mock.calls[0][2];
    expect(html).toContain('ABCD-2345');
    expect(html).toContain('WXYZ-6789');
  });

  it('returns false (no throw) when YeboLink throws', async () => {
    send.mockRejectedValue(new Error('YeboLink email send failed'));
    const ok = await EmailService.sendTicketConfirmation('buyer@example.com', tickets);
    expect(ok).toBe(false);
  });

  it('returns false for an empty tickets array without calling YeboLink', async () => {
    const ok = await EmailService.sendTicketConfirmation('buyer@example.com', []);
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
