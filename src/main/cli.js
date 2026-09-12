// Command-line parsing for the Explorer verbs. Pure; tested.
//
//   Unpacker.exe --compress "C:\a" "C:\b"
//   Unpacker.exe --extract-here "C:\x.zip"
//   Unpacker.exe --extract-to "C:\x.zip"
//   Unpacker.exe --convert "C:\x.rar"
//   Unpacker.exe --test "C:\x.7z"

const FLAGS = ["--compress", "--extract-here", "--extract-to", "--extract-all", "--convert", "--test"];

function parseCli(argv) {
  const out = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (FLAGS.includes(a)) {
      const paths = [];
      i += 1;
      while (i < argv.length && !argv[i].startsWith("--")) {
        paths.push(argv[i]);
        i += 1;
      }
      out.push({ flag: a, paths });
    } else {
      i += 1;
    }
  }
  return out;
}

module.exports = { parseCli, FLAGS };
