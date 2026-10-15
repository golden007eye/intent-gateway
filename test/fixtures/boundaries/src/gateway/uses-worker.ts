// Bypass: a worker thread has its own fetch; through the bare specifier.
import { Worker } from "worker_threads";

export const usesWorker = typeof Worker;
