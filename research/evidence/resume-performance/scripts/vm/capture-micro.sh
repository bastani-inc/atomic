#!/usr/bin/env bash
# capture-micro.sh <src-repo>: the Git work of one capture in a fresh clone (racily clean index, like
# actions/checkout), done three ways:
#   today       copy the user's index keeping its mtime, read-tree --reset HEAD, diff-files, ls-files twice
#   persistent  a private index kept between captures and refreshed once (update-index --refresh writes it), so its
#               entries stop being racily clean; one ignored listing (diff-index --cached --diff-filter=A HEAD)
#   +untracked  persistent, plus core.untrackedCache=true stored in that private index
# Prints the median of 5 of each, in ms. Nothing here touches the clone's own index.
set -u
SRC=$1; N=$(basename $SRC); D=${RP:-$HOME/bench}/micro/$N; rm -rf $D; mkdir -p $(dirname $D)
git -c advice.detachedHead=false clone -q --no-hardlinks $SRC $D; cd $D
P=$(mktemp -d); export GIT_OPTIONAL_LOCKS=0
ms() { local s=$(date +%s%N); "$@" > /dev/null 2>&1; echo $(( ($(date +%s%N)-s)/1000000 )); }
med() { sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}'; }
today() {
  cp --preserve=timestamps .git/index $P/i1
  GIT_INDEX_FILE=$P/i1 git read-tree --reset HEAD; GIT_INDEX_FILE=$P/i1 git diff-files -z --name-only --no-renames
  git ls-files -z --cached --ignored --exclude-standard; GIT_INDEX_FILE=$P/i1 git ls-files -z --cached --ignored --exclude-standard
  GIT_INDEX_FILE=$P/i1 git ls-files -z --others --exclude-standard; GIT_INDEX_FILE=$P/i1 git write-tree; }
persistent() { # $1: extra -c options
  [ -f $P/i2$2 ] || cp --preserve=timestamps .git/index $P/i2$2
  GIT_INDEX_FILE=$P/i2$2 git $1 read-tree --reset HEAD; GIT_INDEX_FILE=$P/i2$2 git $1 update-index -q --refresh
  GIT_INDEX_FILE=$P/i2$2 git $1 diff-files -z --name-only --no-renames
  git diff-index --cached --name-only --diff-filter=A HEAD
  GIT_INDEX_FILE=$P/i2$2 git $1 ls-files -z --others --exclude-standard; GIT_INDEX_FILE=$P/i2$2 git $1 write-tree; }
echo "$N tracked=$(git ls-files | wc -l)"
echo "today      $(for i in 1 2 3 4 5; do ms today; done | med)"
echo "persistent first=$(ms persistent '' a) then $(for i in 1 2 3 4 5; do ms persistent '' a; done | med)"
U="-c core.untrackedCache=true"
GIT_INDEX_FILE=$P/i2b git $U update-index --untracked-cache > /dev/null 2>&1 || true
echo "+untracked first=$(ms persistent "$U" b) then $(for i in 1 2 3 4 5; do ms persistent "$U" b; done | med)"
sleep 1.1; GIT_OPTIONAL_LOCKS=1 git status > /dev/null
echo "today after git status $(for i in 1 2 3 4 5; do ms today; done | med)"
rm -rf $P
