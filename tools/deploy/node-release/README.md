# Verified Node runtime

The production Dockerfile replaces the Node prefix in a pinned official Bookworm
base with the official Node v24.22.1 glibc release. The same stage supplies the
build, checks and runtime stages. `docker build .` and the existing Compose build
need no private local files or prebuilt runtime image.

The installer replaces only the release's bundled npm with official npm 11.21.1
from https://registry.npmjs.org/npm/-/npm-11.21.1.tgz. Its SHA512 is pinned from
the registry's `dist.integrity` before extraction; a mismatch stops the build.
Node 24.22.1 satisfies npm's `^20.17.0 || >=22.9.0` requirement. All three
stages use this npm for the existing locked install/build/prune operations;
the product image CI checks both exact Node and npm versions. Updating npm
requires reviewing the version, registry integrity and runtime check together.

`SHASUMS256.txt.asc` is from https://nodejs.org/dist/v24.22.1/ .
`nodejs-release-keyring.kbx` is the public keyring retrieved from
https://github.com/nodejs/release-keys (gpg/pubring.kbx), SHA256
`610b8d249da3d5733f5a128def2dd0294dbbf5b5713e6ca2529db8db419dee00`.
The pinned signer is `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`.
These are public verification assets, not credentials. The build verifies the
signature and authorized signer, then the downloaded archive checksum, before
extracting it. Failed verification stops the build. Updating Node requires
reviewing the version, signed manifest and authorized signer together.

The fetch stage installs curl/gpgv/xz and a transport CA bundle. Those packages
and its bundle do not enter the product image. The runtime keeps the base OS,
uses the official Node bundled trust store and preserves the application's
Apple Root CA G2/G3 certificate files. No TLS verification override is used.

Mappings exist for amd64, arm64, ppc64le and s390x glibc releases; unsupported
architectures fail explicitly. Only linux/amd64 is validated for this product's
current deployment. Other CPU mappings are not runtime compatibility evidence.
This is not an Alpine/musl recipe.

CI builds `--target checks` for type/build and the server suite, then builds the
default final product and checks its Node version and bundled/effective roots.
It also rejects an incorrect archive and a forged signed manifest whose edited
checksum matches that archive, and boots the product with a fresh tmpfs, no
network, no production data or secrets, then checks public/auth boundaries and
SIGTERM shutdown.
Existing server shutdown tests need `--test-force-exit` after their assertions.
This does not test real login, purchases, notifications or connector delivery.
A production update still requires the deployment conditions and audit handoff;
merely building this recipe does not update a running container.
