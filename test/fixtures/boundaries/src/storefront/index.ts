// Allowed: the storefront transport may open connections (the store pair check's GET).
import { connect } from "node:tls";

export const storefront = typeof connect;
