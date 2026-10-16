// The approval link as a QR code, so the buyer can open the confirm page on a phone.
import qrcode from "qrcode-generator";

export interface ApprovalQr {
  /** Text QR code (Unicode half blocks) for a terminal or a chat client that shows monospace text. */
  readonly text: string;
  /** The same code as a `data:image/gif;base64,…` URL, for clients that show images. */
  readonly data_url: string;
}

export function approvalQr(url: string): ApprovalQr {
  // Type 0 picks the smallest version that fits; level M survives a scuffed screen.
  const code = qrcode(0, "M");
  code.addData(url);
  code.make();
  return { text: code.createASCII(1, 2), data_url: code.createDataURL(4, 4) };
}
