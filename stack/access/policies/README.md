# A deployment's own policies

This folder holds the Cerbos policies a deployment adds to the defaults. The
defaults ship in the image, at `/app/access/policies`; compose mounts this
folder beside them, at `/policies/deployment`, and Cerbos loads both.

It is empty in this repository, because the core has no deployment of its
own. It exists so that `stack/compose.yml` starts from `stack/` as it does
from a deployment made by `pbmb init`, whose own `access/policies/` sits
beside its `compose.yml`. The bind mount does not create a missing folder,
so a deployment without one stops at start rather than running with none.

Cerbos reads only `.yaml`, `.yml` and `.json` files, so this README is
ignored.
