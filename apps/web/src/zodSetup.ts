/**
 * main.tsx'in İLK içe aktarımı olmalı: zod nesne şemaları JIT kararını OLUŞTURULURKEN verir
 * (`new Function` denemesi) ve core şemaları modül yüklenirken oluşur. CSP `unsafe-eval` vermez;
 * deneme yakalansa bile `securitypolicyviolation` raporlanır. jitless ile deneme hiç yapılmaz.
 */
import { config } from 'zod';

config({ jitless: true });
