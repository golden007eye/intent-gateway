// Bypass: an EventSource stream opens an HTTP request.
export const usesEventSource = () => new EventSource("https://cloud.example");
