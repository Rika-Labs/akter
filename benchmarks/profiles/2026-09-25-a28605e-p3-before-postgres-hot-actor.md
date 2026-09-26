# hot-actor warm turns, a28605e (p3-before), postgres

5000 sequential `Add` turns on one resident actor after 500 warm-up turns, sampled every 100 µs. The process spent 3.773 CPU ms per turn (profiler overhead included) over 3.622 ms of wall time per turn.

Commit `a28605e8d3a378a1b14f86d80fc654093796d632`, PostgreSQL 18.6 (Debian 18.6-1.pgdg12+2).

Sampled 18093.5 ms, of which 18093.5 ms on the CPU. Percentages are of CPU time.

## Self time by area

| Share |      Time | Area                           |
| ----: | --------: | ------------------------------ |
| 37.3% | 6756.3 ms | `effect/core`                  |
| 36.9% | 6675.1 ms | `native`                       |
|  9.2% |   1670 ms | `effect/schema`                |
|  5.3% |  967.4 ms | `@effect/sql-pg`               |
|  3.4% |    617 ms | `effect/unstable/sql`          |
|  2.8% |  511.2 ms | `durable-actors/runtime`       |
|  1.6% |  290.9 ms | `effect/unstable/cluster`      |
|  1.3% |  232.2 ms | `durable-actors/actor`         |
|  0.8% |  149.1 ms | `effect/unstable/rpc`          |
|  0.6% |  109.5 ms | `runtime builtins`             |
|  0.4% |   71.6 ms | `other`                        |
|  0.1% |   21.4 ms | `durable-actors/identity`      |
|  0.1% |   15.9 ms | `durable-actors/handles`       |
|    0% |    3.5 ms | `durable-actors/contexts`      |
|    0% |    1.9 ms | `@effect/platform-node-shared` |
|    0% |    0.2 ms | `effect/unstable/http`         |

## Inclusive time in the runtime's own functions

| Share |      Time | Function       | Location                                         |
| ----: | --------: | -------------- | ------------------------------------------------ |
|  6.3% | 1136.1 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:530       |
|  5.4% |  977.4 ms | `(anonymous)`  | durable-actors/src/runtime/turn/execute.ts:64    |
|  3.4% |  606.5 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:151          |
|  2.1% |  373.3 ms | `(anonymous)`  | durable-actors/src/runtime/entity/register.ts:60 |
|  1.7% |  305.8 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:166          |
|  1.5% |  271.4 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:484       |
|  1.5% |  265.3 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:369       |
|  1.2% |  220.1 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:621       |
|  1.2% |  217.8 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:706       |
|  0.9% |  165.1 ms | `(anonymous)`  | durable-actors/src/actor/definition.ts:609       |
|  0.8% |  150.8 ms | `(anonymous)`  | durable-actors/src/runtime/turn/execute.ts:57    |
|  0.7% |  126.8 ms | `commandTimes` | durable-actors/src/identity/command.ts:16        |
|  0.7% |  124.1 ms | `(anonymous)`  | durable-actors/src/runtime/turn/receipt.ts:9     |
|  0.7% |  123.5 ms | `(anonymous)`  | durable-actors/src/runtime/turn/admission.ts:22  |
|  0.4% |   70.1 ms | `(anonymous)`  | durable-actors/src/runtime/turn/admission.ts:42  |
|  0.4% |   66.1 ms | `routingKey`   | durable-actors/src/runtime/storage/codec.ts:12   |
|  0.2% |   34.5 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:199          |
|  0.2% |   34.3 ms | `(anonymous)`  | durable-actors/src/runtime/turn/admission.ts:8   |
|  0.2% |   31.1 ms | `(anonymous)`  | durable-actors/src/runtime/turn/rows.ts:344      |
|  0.2% |   30.4 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:109          |
|  0.2% |   27.8 ms | `(anonymous)`  | durable-actors/src/runtime/turn/execute.ts:126   |
|  0.2% |   27.8 ms | `(anonymous)`  | durable-actors/src/runtime/turn/receipt.ts:14    |
|  0.1% |   21.5 ms | `compress`     | durable-actors/src/runtime/storage/codec.ts:31   |
|  0.1% |   21.3 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:139          |
|  0.1% |   17.7 ms | `(anonymous)`  | durable-actors/src/runtime/turn/outbox.ts:53     |
|  0.1% |   12.9 ms | `(anonymous)`  | durable-actors/src/runtime/layer.ts:104          |
|  0.1% |   12.2 ms | `execute`      | durable-actors/src/runtime/layer.ts:406          |
|  0.1% |   11.5 ms | `openOutbox`   | durable-actors/src/handles/intents.ts:67         |
|  0.1% |   11.2 ms | `(anonymous)`  | durable-actors/src/runtime/events/append.ts:16   |
|  0.1% |     11 ms | `close`        | durable-actors/src/handles/intents.ts:97         |

## Hottest functions by self time

| Share |      Time | Function                     | Location                                       |
| ----: | --------: | ---------------------------- | ---------------------------------------------- |
| 17.7% | 3202.5 ms | `writeBuffered`              | [native code]                                  |
|  4.4% |  799.1 ms | `runLoop`                    | effect/dist/internal/effect.js:465             |
|  2.7% |  493.2 ms | `Map`                        | [native code]                                  |
|    2% |  361.8 ms | `(anonymous)`                | effect/dist/internal/effect.js:1148            |
|  1.9% |  339.1 ms | `create`                     | [native code]                                  |
|  1.9% |  335.3 ms | `getOwnPropertyDescriptors`  | [native code]                                  |
|  1.8% |    334 ms | `(anonymous)`                | effect/dist/internal/effect.js:1366            |
|  1.6% |  281.3 ms | `get`                        | @effect/sql-pg/dist/PgConnection.js:669        |
|  1.6% |  280.8 ms | `(anonymous)`                | effect/dist/internal/core.js:253               |
|  1.1% |    205 ms | `statement`                  | effect/dist/unstable/sql/Statement.js:240      |
|  1.1% |  198.4 ms | `PrimitiveImpl`              | effect/dist/internal/core.js:249               |
|  1.1% |  198.1 ms | `zstdCompressSync`           | [native code]                                  |
|    1% |  175.8 ms | `(anonymous)`                | effect/dist/SchemaAST.js:1579                  |
|    1% |  173.3 ms | `assignProperty`             | effect/dist/internal/record.js:2               |
|  0.9% |  155.6 ms | `attribute`                  | effect/dist/Tracer.js:329                      |
|  0.8% |  153.2 ms | `compile`                    | effect/dist/unstable/sql/Statement.js:339      |
|  0.8% |  146.5 ms | `ExitPrimitive`              | effect/dist/internal/core.js:283               |
|  0.8% |  141.8 ms | `lookup`                     | effect/dist/Context.js:148                     |
|  0.8% |  140.8 ms | `~effect/Effect/evaluate`    | effect/dist/internal/core.js:295               |
|  0.8% |  136.4 ms | `make`                       | effect/dist/internal/schema/make.js:22         |
|  0.8% |  136.1 ms | `join`                       | [native code]                                  |
|  0.7% |  131.9 ms | `(anonymous)`                | effect/dist/internal/effect.js:813             |
|  0.7% |  129.8 ms | `getCont`                    | effect/dist/internal/effect.js:512             |
|  0.7% |  124.5 ms | `(anonymous)`                | effect/dist/internal/effect.js:2867            |
|  0.7% |  122.7 ms | `(anonymous)`                | durable-actors/src/runtime/turn/execute.ts:64  |
|  0.7% |  119.3 ms | `Error`                      | [native code]                                  |
|  0.7% |  118.2 ms | `stringify`                  | [native code]                                  |
|  0.7% |  117.8 ms | `generatorResume`            | [native code]                                  |
|  0.6% |  116.5 ms | `makeSpanUnsafe`             | effect/dist/internal/effect.js:2651            |
|  0.6% |  113.5 ms | `from`                       | [native code]                                  |
|  0.6% |  112.9 ms | `(anonymous)`                | effect/dist/internal/schema/interpreter.js:140 |
|  0.6% |  105.1 ms | `(anonymous)`                | effect/dist/internal/core.js:287               |
|  0.5% |   96.9 ms | `(anonymous)`                | effect/dist/Function.js:76                     |
|  0.5% |   90.3 ms | `callback`                   | effect/dist/internal/effect.js:864             |
|  0.5% |   89.3 ms | `(anonymous)`                | effect/dist/Predicate.js:790                   |
|  0.5% |   85.4 ms | `~effect/Effect/successCont` | effect/dist/internal/effect.js:1815            |
|  0.5% |   83.3 ms | `map`                        | [native code]                                  |
|  0.5% |   82.6 ms | `applyOverlays`              | effect/dist/Context.js:129                     |
|  0.5% |   82.2 ms | `setTimeout`                 | [native code]                                  |
|  0.4% |   79.7 ms | `(anonymous)`                | effect/dist/Context.js:537                     |
|  0.4% |   77.5 ms | `stringSplitFast`            | [native code]                                  |
|  0.4% |   76.5 ms | `(anonymous)`                | effect/dist/internal/effect.js:879             |
|  0.4% |     75 ms | `forEach`                    | [native code]                                  |
|  0.4% |   71.5 ms | `encodeQuery`                | @effect/sql-pg/dist/PgConnection.js:598        |
|  0.4% |   71.4 ms | `push`                       | [native code]                                  |
|  0.4% |   69.7 ms | `defineFunctionLength`       | effect/dist/internal/effect.js:889             |
|  0.4% |   69.4 ms | `parseChecks`                | effect/dist/internal/schema/interpreter.js:87  |
|  0.4% |   67.5 ms | `utf8`                       | @effect/sql-pg/dist/PgProtocol.js:268          |
|  0.4% |   67.3 ms | `compile`                    | effect/dist/internal/schema/interpreter.js:69  |
|  0.4% |     66 ms | `(anonymous)`                | effect/dist/SchemaAST.js:2009                  |
