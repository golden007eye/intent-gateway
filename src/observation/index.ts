// observation: the `observed` entry, a local summary of what Intent Cloud returned for one acknowledged request
// (offers, the cart, the approval state), built with buyer identity withheld. Never sent; not a disclosure. Pure.
export {
  OBSERVED_ENDPOINTS,
  OBSERVED_OFFERS_MAX,
  ObservedBody,
  ObservedOffer,
  observationProblem,
  observeApproval,
  observeCart,
  observeSearch,
  observeStatus,
  WITHHELD,
} from "./observation.ts";
