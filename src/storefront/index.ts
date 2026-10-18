// The merchant storefront transport (contract 1.6.1 store pair check; ADR-0020). Only src/disclosure may import this
// module (`only-disclosure-reaches-storefront`): connectStorefront wraps it in the disclosure core, so the URL is
// logged before the GET leaves. The pure rules (metaUrl, storePairProblem) are src/contract's.
export {
  createStorefrontTransport,
  isPublicAddress,
  META_OPERATION,
  STOREFRONT_USER_AGENT,
  type StorefrontRequest,
  StorefrontRequestError,
  type StorefrontResponse,
  type StorefrontTransport,
  StorefrontTransportError,
  type StorefrontTransportOptions,
} from "./transport.ts";
