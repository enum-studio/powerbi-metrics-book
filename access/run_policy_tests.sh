#!/bin/sh
# Runs the policy tests in the Cerbos image the stack pins, with the policies
# mounted where the stack mounts them: the defaults at /policies/default, a
# deployment's own at /policies/deployment. First the defaults alone
# (tests/), then each example deployment in layering_tests/ on top of them.
set -eu

image=ghcr.io/cerbos/cerbos:0.57.0@sha256:e5e3b150b3cb0090975605254f255164567d67e233634199fb20972e3eaff300
access=$(cd "$(dirname "$0")" && pwd)

compile() {
  docker run --rm --network none \
    --volume "$access/policies:/policies/default:ro" "$@" \
    "$image" compile --tests=/tests /policies
}

compile --volume "$access/tests:/tests:ro"
for example in "$access"/layering_tests/*/; do
  compile --volume "${example}policies:/policies/deployment:ro" \
    --volume "${example}tests:/tests:ro"
done
