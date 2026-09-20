# Error model

**Responsibility:** define errors across runtime, transports, and SDKs.  
**Authority:** normative.  
**Owner role:** API/runtime.  
**Change policy:** error code changes require client compatibility review.

Core categories:

| Error             | Retry               | Disclosure                    |
| ----------------- | ------------------- | ----------------------------- |
| Invalid input     | no                  | safe                          |
| Unauthenticated   | after auth          | safe                          |
| Unauthorized      | no                  | non-disclosing                |
| Wrong owner       | no                  | explicit to authorized caller |
| Stale generation  | yes                 | safe                          |
| Duplicate command | observe receipt     | safe                          |
| Command conflict  | no                  | safe                          |
| Unavailable       | yes                 | safe                          |
| Timeout           | depends on boundary | safe                          |
| Unknown effect    | reconcile           | safe, prominent               |
| Expired receipt   | new identity        | safe                          |
| Cursor expired    | resync              | safe                          |
| Unsupported query | no                  | actionable                    |

Effect failures, Promise rejections, HTTP responses, WebSocket frames, and CLI output must preserve the same semantic category.
