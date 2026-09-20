# domains-certificates example boundary

This is a planned example, not a running actor application. Implement it only after the corresponding core gates pass.

Structure: schema/protocol/definition/repo/service/actor under src, with test folders mirroring src. HTTP and CLI import public protocols, not repositories. External operations go through durable work; projections are eventual. See ../../docs/PROGRAMMING_MODEL.md and ../../docs/IMPLEMENTATION_BACKLOG.md.
