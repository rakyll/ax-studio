#!/bin/sh
# docker -> podman shim written by AX Studio for kind, Agent Substrate and AX
# scripts on machines that only have podman.
#
# - push/pull of localhost images skip TLS: the kind registry is plain HTTP.
# - push records the digest the registry stored; podman recompresses layers,
#   so the local RepoDigests that `inspect` reports would not match it.
# - `buildx build --push` builds a podman manifest and pushes it, recording
#   the pushed digest so `buildx imagetools inspect` can report it, and
#   writing it to --metadata-file as buildx would.

digests=${TMPDIR:-/tmp}/ax-studio-buildx
digestfile() { printf '%s/%s' "$digests" "$(printf '%s' "$1" | tr '/:@' '___')"; }
tls() { case "$1" in localhost:*|127.0.0.1:*) echo --tls-verify=false ;; esac; }

buildx_build() {
  plat= tag= push= meta=
  n=$#
  while [ "$n" -gt 0 ]; do
    a=$1; shift; n=$((n - 1))
    case "$a" in
      --push) push=1 ;;
      --load) ;;
      --platform=*) plat=${a#--platform=} ;;
      --platform) plat=$1; shift; n=$((n - 1)) ;;
      --metadata-file=*) meta=${a#--metadata-file=} ;;
      --metadata-file) meta=$1; shift; n=$((n - 1)) ;;
      --tag=*) tag=${a#--tag=} ;;
      -t|--tag) tag=$1; shift; n=$((n - 1)) ;;
      *) set -- "$@" "$a" ;;
    esac
  done
  if [ -z "$push" ] || [ -z "$tag" ]; then
    exec podman build ${plat:+--platform "$plat"} ${tag:+-t "$tag"} "$@"
  fi
  podman manifest rm "$tag" >/dev/null 2>&1 || podman rmi "$tag" >/dev/null 2>&1 || true
  podman build ${plat:+--platform "$plat"} --manifest "$tag" "$@" || exit
  mkdir -p "$digests"
  f=$(digestfile "$tag")
  podman manifest push --all $(tls "$tag") --digestfile "$f" "$tag" "docker://$tag" || exit
  [ -z "$meta" ] || printf '{"image.name":"%s","containerimage.digest":"%s"}\n' "$tag" "$(cat "$f")" > "$meta"
}

imagetools_inspect() {
  ref=
  while [ $# -gt 0 ]; do
    case "$1" in
      --format|--builder) shift ;;
      -*) ;;
      *) ref=$1 ;;
    esac
    shift
  done
  f=$(digestfile "$ref")
  [ -s "$f" ] || { echo "ax-studio docker shim: no recorded digest for $ref" >&2; exit 1; }
  printf '{"name":"%s","manifest":{"digest":"%s"}}\n' "$ref" "$(cat "$f")"
}

lastarg() { for a in "$@"; do l=$a; done; printf '%s' "$l"; }

case "$1" in
  run)
    shift
    n=$# name=
    while [ "$n" -gt 0 ]; do
      a=$1; shift; n=$((n - 1))
      case "$a" in
        --name) name=$1; set -- "$@" "$a" "$1"; shift; n=$((n - 1)) ;;
        --name=*) name=${a#--name=}; set -- "$@" "$a" ;;
        -p|--publish) case "$1" in "[::1]:"*) ;; *) set -- "$@" "$a" "$1" ;; esac; shift; n=$((n - 1)) ;;
        -p\[::1\]:*|--publish=\[::1\]:*) ;;
        *) set -- "$@" "$a" ;;
      esac
    done
    if [ -n "$name" ] && [ "$(podman inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = false ]; then
      podman rm -f "$name" >/dev/null
    fi
    exec podman run "$@" ;;
  pull)
    shift
    exec podman pull $(tls "$(lastarg "$@")") "$@" ;;
  push)
    shift
    ref=$(lastarg "$@")
    case " $* " in *" --digestfile"*) exec podman push $(tls "$ref") "$@" ;; esac
    # podman leaves --digestfile empty when -q is given, so drop it.
    n=$#
    while [ "$n" -gt 0 ]; do
      a=$1; shift; n=$((n - 1))
      case "$a" in -q|--quiet) ;; *) set -- "$@" "$a" ;; esac
    done
    mkdir -p "$digests"
    exec podman push $(tls "$ref") --digestfile "$(digestfile "$ref")" "$@" ;;
  inspect)
    ref=$(lastarg "$@")
    case "$*" in
      *RepoDigests*) [ -s "$(digestfile "$ref")" ] && { printf '%s@%s\n' "${ref%:*}" "$(cat "$(digestfile "$ref")")"; exit 0; } ;;
    esac ;;
  buildx)
    case "$2" in
      build) shift 2; buildx_build "$@"; exit ;;
      imagetools) [ "$3" = inspect ] && { shift 3; imagetools_inspect "$@"; exit; } ;;
      version) echo "github.com/docker/buildx ax-studio-podman-shim"; exit 0 ;;
    esac ;;
esac
exec podman "$@"
