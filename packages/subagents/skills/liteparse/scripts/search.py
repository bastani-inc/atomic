#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# dependencies = [
#   "bm25s>=0.3.9,<1",
#   "aiofiles>=25.1.0,<26",
# ]
# ///
import argparse
import asyncio
import codecs
import io
import sys
from typing import TypedDict, cast

import aiofiles
import bm25s


class LineRecord(TypedDict):
    index: int
    content: str


def _chunk(content: str) -> list[LineRecord]:
    return [{"index": i, "content": c} for (i, c) in enumerate(content.splitlines())]


def _expand(corpus: list[LineRecord], match: LineRecord, n: int, first_line: int) -> str:
    idx = match["index"]
    start = max(0, idx - n)
    end = min(len(corpus) - 1, idx + n)
    # Atomic: numbered by the line in the whole file, not in the chunk.
    return f"Lines {first_line + start} - {first_line + end}\n\n\n" + "\n".join(
        [c["content"] for c in corpus[start : end + 1]]
    )


def _retrieve(
    corpus: list[LineRecord], query: str, top_k: int | None, expand: int = 0, first_line: int = 0
) -> list[tuple[str, float]]:
    corpus_tokens = bm25s.tokenize([c["content"] for c in corpus])
    retriever = bm25s.BM25(corpus=corpus)
    retriever.index(corpus_tokens)
    query_tokens = bm25s.tokenize(query)
    # Atomic: bm25s refuses to return more matches than the chunk has lines.
    docs, scores = retriever.retrieve(query_tokens, k=min(top_k or 10, len(corpus)))

    results: list[tuple[str, float]] = []
    for doc, score in zip(docs[0].tolist(), scores[0].tolist()):
        window = _expand(corpus, doc, expand, first_line) if expand > 0 else [doc]
        results.append((cast(str, window), score))
    return results


def _chunk_and_retrieve(
    content: str, query: str, top_k: int | None, expand_n: int, first_line: int
) -> list[tuple[str, float]]:
    corpus = _chunk(content)
    return _retrieve(corpus, query, top_k, expand_n, first_line)


async def process_chunk(
    content: str, query: str, top_k: int | None, expand_n: int, first_line: int
) -> list[tuple[str, float]]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        _chunk_and_retrieve,
        content,
        query,
        top_k,
        expand_n,
        first_line,
    )


async def read_and_process(
    file_path: str, query: str, top_k: int | None, expand_n: int | None
) -> list[str]:
    tasks: list[asyncio.Task[list[tuple[str, float]]]] = []
    async with asyncio.TaskGroup() as tg:
        async with aiofiles.open(file_path, "rb") as f:
            # read 64KB chunks
            # Atomic: a chunk ends at the last line end of its block (the last chunk at the end of the file), so no
            # character or line is cut in two, and carries the number of its first line in the whole file. A file of
            # one block is one chunk, as before.
            first_line = 0
            pending: list[bytes] = []  # the start of a line not ended yet, from earlier blocks
            block = await f.read(65536)
            while block:
                following = await f.read(65536)
                cut = block.rfind(b"\n") + 1 if following else len(block)
                if cut:
                    content = b"".join([*pending, block[:cut]]).decode("utf-8")
                    pending = [block[cut:]]
                    tasks.append(
                        tg.create_task(process_chunk(content, query, top_k, expand_n or 5, first_line))
                    )
                    first_line += len(content.splitlines())
                else:
                    pending.append(block)
                block = following
    results = [task.result() for task in tasks]
    flattened = [r for result in results for r in result if r[1] >= 0.5]
    flattened.sort(key=lambda x: x[1], reverse=True)
    n = top_k or 10
    return [f[0] for f in flattened][:n]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("file_path", help="Path to the text file to search")
    parser.add_argument(
        "-q", "--query", help="Keyword-based query to search for", required=True
    )
    parser.add_argument(
        "-k",
        "--top-k",
        help="Top K matches to retrieve. Defaults to 10.",
        required=False,
        type=int,
        default=None,
    )
    parser.add_argument(
        "-e",
        "--expand",
        help="Expand the matched content by N lines (before and after). Defaults to 5",
        required=False,
        type=int,
        default=None,
    )
    args = parser.parse_args()
    results = asyncio.run(
        read_and_process(args.file_path, args.query, args.top_k, args.expand)
    )
    if results:
        separator = "\n" + "─" * 60 + "\n"
        for i, r in enumerate(results):
            print(f"Match #{i}")
            print(r.rstrip("\n").lstrip("\n"))
            if i < len(results) - 1:
                print(separator)
    else:
        print("No relevant matches found")


if __name__ == "__main__":
    # Atomic: matches are read from a pipe as UTF-8, but on Windows Python writes to a pipe in the ANSI code page,
    # such as cp1252, which has no separator line and lacks most characters: write UTF-8 unless the stream already does.
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper) and codecs.lookup(stream.encoding).name != "utf-8":
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    main()
