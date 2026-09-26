# hot-actor warm turns, 781ff5c (p3-after), postgres

5000 sequential `Add` turns on one resident actor after 500 warm-up turns, sampled every 100 µs. The process spent 3.453 CPU ms per turn (profiler overhead included) over 3.365 ms of wall time per turn.

Commit `781ff5c02bfc59d82e8cf9831df0b0f1e66d988f`, PostgreSQL 18.6 (Debian 18.6-1.pgdg12+2).

Sampled 16811.9 ms, of which 16811.9 ms on the CPU. Percentages are of CPU time.

## Self time by area

| Share |      Time | Area                           |
| ----: | --------: | ------------------------------ |
| 40.4% | 6798.3 ms | `effect/core`                  |
| 34.9% | 5871.9 ms | `native`                       |
|  6.4% | 1071.4 ms | `effect/schema`                |
|  5.4% |  912.4 ms | `@effect/sql-pg`               |
|  3.7% |  615.4 ms | `effect/unstable/sql`          |
|    3% |    507 ms | `durable-actors/runtime`       |
|  2.1% |    356 ms | `durable-actors/actor`         |
|  1.9% |  326.4 ms | `effect/unstable/cluster`      |
|  0.8% |  134.2 ms | `effect/unstable/rpc`          |
|  0.5% |   82.3 ms | `other`                        |
|  0.5% |   78.2 ms | `runtime builtins`             |
|  0.2% |   30.4 ms | `durable-actors/identity`      |
|  0.1% |   18.9 ms | `durable-actors/handles`       |
|    0% |    3.8 ms | `durable-actors/contexts`      |
|    0% |    2.8 ms | `effect/unstable/http`         |
|    0% |    2.3 ms | `@effect/platform-node-shared` |

## Inclusive time in the runtime's own functions

| Share |     Time | Function       | Location                                         |
| ----: | -------: | -------------- | ------------------------------------------------ |
|  5.9% | 984.6 ms | `(anonymous)`  | durable-actors/src/runtime/turn/execute.ts:66    |
|  2.2% |   367 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:633       |
|  1.8% | 299.6 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:645       |
|  1.6% | 275.2 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:728       |
|  1.6% | 270.8 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:529       |
|  1.5% | 254.2 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:171          |
|  1.3% | 220.5 ms | `(anonymous)`  | durable-actors/src/runtime/entity/register.ts:60 |
|  1.2% |   206 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:422       |
|  1.1% | 178.7 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:570       |
|  0.9% | 144.8 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:156          |
|  0.7% | 124.8 ms | `(anonymous)`  | durable-actors/src/runtime/turn/execute.ts:59    |
|  0.7% | 123.3 ms | `commandTimes` | durable-actors/src/identity/command.ts:16        |
|  0.7% | 121.5 ms | `(anonymous)`  | durable-actors/src/runtime/turn/admission.ts:24  |
|  0.5% |  82.1 ms | `routingKey`   | durable-actors/src/runtime/storage/codec.ts:12   |
|  0.4% |  73.9 ms | `(anonymous)`  | durable-actors/src/runtime/turn/admission.ts:44  |
|  0.4% |  66.8 ms | `(anonymous)`  | durable-actors/src/runtime/turn/rows.ts:344      |
|  0.4% |    62 ms | `(anonymous)`  | durable-actors/src/runtime/turn/execute.ts:128   |
|  0.3% |    56 ms | `(anonymous)`  | durable-actors/src/runtime/turn/receipt.ts:15    |
|  0.3% |  53.5 ms | `(anonymous)`  | durable-actors/src/runtime/turn/admission.ts:8   |
|  0.3% |  43.3 ms | `compress`     | durable-actors/src/runtime/storage/codec.ts:31   |
|  0.2% |  29.6 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:114          |
|  0.2% |  26.1 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:204          |
|  0.1% |  17.6 ms | `openOutbox`   | durable-actors/src/handles/intents.ts:67         |
|  0.1% |  17.4 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:144          |
|  0.1% |  16.1 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:521       |
|  0.1% |  13.8 ms | `(anonymous)`  | durable-actors/src/runtime/turn/outbox.ts:53     |
|  0.1% |  13.3 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:109          |
|  0.1% |  12.4 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:516       |
|  0.1% |   8.5 ms | `callerKey`    | durable-actors/src/identity/caller.ts:44         |
|    0% |   7.6 ms | `close`        | durable-actors/src/handles/intents.ts:97         |

## Hottest functions by self time

| Share |      Time | Function                     | Location                                                   |
| ----: | --------: | ---------------------------- | ---------------------------------------------------------- |
| 18.6% | 3124.7 ms | `writeBuffered`              | [native code]                                              |
|  5.3% |  895.5 ms | `runLoop`                    | effect/dist/internal/effect.js:465                         |
|  3.9% |  654.1 ms | `Map`                        | [native code]                                              |
|  2.2% |  373.5 ms | `(anonymous)`                | effect/dist/internal/effect.js:1148                        |
|  1.8% |  308.9 ms | `(anonymous)`                | effect/dist/internal/effect.js:1366                        |
|  1.6% |  277.1 ms | `getCont`                    | effect/dist/internal/effect.js:512                         |
|  1.6% |  264.8 ms | `get`                        | @effect/sql-pg/dist/PgConnection.js:669                    |
|  1.5% |  258.2 ms | `statement`                  | effect/dist/unstable/sql/Statement.js:240                  |
|  1.5% |  247.5 ms | `(anonymous)`                | effect/dist/internal/core.js:253                           |
|  1.4% |  227.8 ms | `(anonymous)`                | effect/dist/SchemaAST.js:1579                              |
|  1.2% |    198 ms | `zstdCompressSync`           | [native code]                                              |
|  1.1% |  191.5 ms | `PrimitiveImpl`              | effect/dist/internal/core.js:249                           |
|  0.9% |    158 ms | `assignProperty`             | effect/dist/internal/record.js:2                           |
|  0.9% |  153.7 ms | `compile`                    | effect/dist/unstable/sql/Statement.js:339                  |
|  0.9% |  148.4 ms | `lookup`                     | effect/dist/Context.js:148                                 |
|  0.9% |    145 ms | `ExitPrimitive`              | effect/dist/internal/core.js:283                           |
|  0.8% |  139.8 ms | `attribute`                  | effect/dist/Tracer.js:329                                  |
|  0.8% |  136.9 ms | `(anonymous)`                | effect/dist/internal/effect.js:813                         |
|  0.8% |  132.6 ms | `(anonymous)`                | effect/dist/internal/effect.js:2867                        |
|  0.8% |    131 ms | `(anonymous)`                | effect/dist/internal/schema/interpreter.js:140             |
|  0.8% |  129.5 ms | `(anonymous)`                | effect/dist/internal/core.js:287                           |
|  0.8% |  126.9 ms | `(anonymous)`                | durable-actors/src/runtime/turn/execute.ts:66              |
|  0.7% |  121.3 ms | `stringify`                  | [native code]                                              |
|  0.7% |  117.1 ms | `makeSpanUnsafe`             | effect/dist/internal/effect.js:2651                        |
|  0.7% |  109.7 ms | `(anonymous)`                | effect/dist/SchemaAST.js:2009                              |
|  0.6% |  108.7 ms | `from`                       | [native code]                                              |
|  0.6% |    108 ms | `(anonymous)`                | effect/dist/Function.js:76                                 |
|  0.6% |  104.9 ms | `make`                       | effect/dist/internal/schema/make.js:22                     |
|  0.6% |  104.7 ms | `push`                       | [native code]                                              |
|  0.6% |   98.4 ms | `join`                       | [native code]                                              |
|  0.6% |     95 ms | `generatorResume`            | [native code]                                              |
|  0.6% |   93.1 ms | `(anonymous)`                | durable-actors/src/actor/definition.ts:728                 |
|  0.5% |   87.5 ms | `callback`                   | effect/dist/internal/effect.js:864                         |
|  0.5% |   86.4 ms | `forEach`                    | [native code]                                              |
|  0.5% |   85.6 ms | `(anonymous)`                | effect/dist/internal/effect.js:879                         |
|  0.5% |     85 ms | `(anonymous)`                | effect/dist/Context.js:537                                 |
|  0.5% |   81.5 ms | `(anonymous)`                | effect/dist/unstable/cluster/internal/entityManager.js:265 |
|  0.5% |   81.3 ms | `(anonymous)`                | effect/dist/Predicate.js:790                               |
|  0.5% |   79.5 ms | `~effect/Effect/successCont` | effect/dist/internal/effect.js:1815                        |
|  0.5% |   77.5 ms | `defineFunctionLength`       | effect/dist/internal/effect.js:889                         |
|  0.4% |   72.9 ms | `stringSplitFast`            | [native code]                                              |
|  0.4% |   71.6 ms | `applyOverlays`              | effect/dist/Context.js:129                                 |
|  0.4% |     71 ms | `(anonymous)`                | durable-actors/src/actor/definition.ts:645                 |
|  0.4% |   68.6 ms | `encodeQuery`                | @effect/sql-pg/dist/PgConnection.js:598                    |
|  0.4% |   67.1 ms | `parseChecks`                | effect/dist/internal/schema/interpreter.js:87              |
|  0.4% |   66.3 ms | `(anonymous)`                | effect/dist/Function.js:68                                 |
|  0.4% |   66.3 ms | `(anonymous)`                | durable-actors/src/actor/definition.ts:633                 |
|  0.4% |   65.3 ms | `setTimeout`                 | [native code]                                              |
|  0.4% |     65 ms | `parse`                      | [native code]                                              |
|  0.4% |   62.5 ms | `copyDataProperties`         | [native code]                                              |
