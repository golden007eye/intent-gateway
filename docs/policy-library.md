# Policy library

!!! planned "Planned"
    The policy library and the `intent policy` commands do not exist yet.

The policy library is a planned public, signed collection of shared gateway policies, reviewed by pull request. Because a gateway policy can only narrow Intent Cloud's rules, adding a library policy can make your gateway stricter but never looser.

```console
$ intent policy add no-history
$ intent policy test
```

`intent policy add` would merge a library policy into your `policy.yaml` and show the change as a diff before applying it:

```diff
 share:
-  history: true
+  history: false
 spend:
-  per_order_usd: 100
+  per_order_usd: 60
```

`intent policy test` would check the resulting policy against sample requests before you run the gateway with it.
