// Node 22.23.3's ToNamespacedPath (src/path.cc, Windows branch), one path per line on stdin.
#include "path_win.cc"
#include <iostream>
int main() {
  node::Environment env{"C:\\Users\\me\\AppData\\Roaming\\sh.quintal.desktop\\personal"};
  std::string line;
  while (std::getline(std::cin, line)) { node::BufferValue p{line}; node::ToNamespacedPath(&env, &p); std::cout << p.s << "\n"; }
}
