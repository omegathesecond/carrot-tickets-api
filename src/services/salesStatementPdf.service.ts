import PDFDocument from 'pdfkit';

/** Layout only: CSV and PDF receive the very same rows and totals. */
export class SalesStatementPdfService {
  static async render(rows: any[][], kind: 'event' | 'merchant'): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      try {
        const tableStart = rows.findIndex(row => row[0] === 'Sale ID');
        const headers = rows[tableStart];
        if (!headers) throw new Error('Statement table headers are missing');
        const selected = kind === 'event'
          ? ['Sale ID', 'Sold At (UTC)', 'Quantity', 'Net Tickets', 'Total Amount', 'Refunded Amount', 'Net Ticket Revenue', 'Payment Method']
          : ['Sale ID', 'Sold At (UTC)', 'Status', 'Charged', 'Customer Surcharge', 'Commission', 'Net Owed'];
        const labels = kind === 'event'
          ? ['Sale / Customer', 'Sold at (UTC)', 'Tickets', 'Net tickets', 'Gross', 'Refunds', 'Net revenue', 'Payment']
          : ['Sale / Operator', 'Sold at (UTC)', 'Status / Reversal', 'Charged', 'Surcharge', 'Commission', 'Net owed'];
        const widths = kind === 'event' ? [178, 120, 48, 54, 76, 76, 88, 130] : [170, 120, 185, 75, 75, 70, 75];
        const pageTitle = String(rows[0]![0]);
        const eventName = String(rows.find(row => row[0] === 'Event')?.[1]);
        const width = doc.page.width - 72;
        const scale = width / widths.reduce((a, b) => a + b, 0);
        const colWidths = widths.map(w => w * scale);
        let y = 36;
        const title = () => {
          doc.font('Helvetica-Bold').fontSize(11).fillColor('#FF6B35').text('CARROT TICKETS', 36, 30, { width });
          doc.fontSize(20).fillColor('#111111').text(pageTitle, 36, 51, { width });
          y = 81;
        };
        const tableHeader = () => {
          doc.rect(36, y, width, 30).fill('#182433');
          let x = 36;
          labels.forEach((label, i) => {
            doc.font('Helvetica-Bold').fontSize(8).fillColor('white').text(label, x + 5, y + 7, { width: colWidths[i]! - 10 });
            x += colWidths[i]!;
          });
          y += 30;
        };
        title();
        // Label/value pairs preserve every summary figure from the CSV.
        rows.slice(1, tableStart).filter(row => row[0] !== '').forEach(row => {
          const text = row.length > 1 ? `${row[0]}: ${row[1]}` : String(row[0]);
          doc.font('Helvetica').fontSize(9).fillColor('#334155');
          const height = doc.heightOfString(text, { width }) + 4;
          if (y + height > doc.page.height - 70) { doc.addPage(); title(); }
          doc.text(text, 36, y, { width });
          y += height;
        });
        y += 10;
        if (y + 55 > doc.page.height - 48) { doc.addPage(); title(); }
        tableHeader();
        const transactions = rows.slice(tableStart + 1);
        if (!transactions.length) doc.font('Helvetica').fontSize(10).fillColor('#334155').text('No completed sales recorded.', 41, y + 12);
        transactions.forEach((row, index) => {
          const cells = selected.map(key => String(row[headers.indexOf(key)]));
          if (kind === 'event') {
            cells[0] += `\n${row[headers.indexOf('Customer Name')]}`;
          } else {
            cells[0] += `\n${row[headers.indexOf('Operator')]}`;
            const reversedAt = row[headers.indexOf('Reversed At (UTC)')];
            if (reversedAt) cells[2] += `\n${reversedAt}\n${row[headers.indexOf('Reversal Reason')]}`;
          }
          cells[1] = cells[1]!.replace('T', '\n').replace('.000Z', 'Z');
          doc.font('Helvetica').fontSize(8);
          const height = Math.max(32, ...cells.map((cell, i) => doc.heightOfString(cell, { width: colWidths[i]! - 10 }) + 12));
          if (y + height > doc.page.height - 48) { doc.addPage(); title(); tableHeader(); }
          if (index % 2 === 0) doc.rect(36, y, width, height).fill('#F1F5F9');
          let x = 36;
          cells.forEach((cell, i) => {
            doc.font('Helvetica').fontSize(8).fillColor('#111111').text(cell, x + 5, y + 6, { width: colWidths[i]! - 10 });
            x += colWidths[i]!;
          });
          y += height;
        });
        const pages = doc.bufferedPageRange();
        for (let i = 0; i < pages.count; i++) {
          doc.switchToPage(i);
          const bottomMargin = doc.page.margins.bottom;
          doc.page.margins.bottom = 0;
          doc.font('Helvetica').fontSize(8).fillColor('#64748B').text(`${eventName} | Page ${i + 1} of ${pages.count}`, 36, doc.page.height - 31, { width, lineBreak: false });
          doc.page.margins.bottom = bottomMargin;
        }
        doc.end();
      } catch (error) { reject(error); doc.end(); }
    });
  }
}
