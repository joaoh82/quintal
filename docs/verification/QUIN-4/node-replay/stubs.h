// Just enough of Node's Environment/BufferValue for src/path.cc's Windows branch.
#include <string>
#include <string_view>
#include <vector>
#include <cstring>
#include <cctype>
#include <cstdlib>
namespace node {
struct Environment {
  std::string cwd;
  std::string GetCwd(const std::string&) { return cwd; }
  std::string exec_path() { return ""; }
};
namespace credentials {
inline bool SafeGetenv(const char* k, std::string* out, Environment*) { const char* v = getenv(k); if (v) *out = v; return v; }
}
inline std::string ToLower(const std::string& s) { std::string r = s; for (auto& c : r) c = tolower(c); return r; }
struct BufferValue {
  std::string s;
  explicit BufferValue(std::string v) : s(std::move(v)) {}
  size_t length() const { return s.size(); }
  std::string_view ToStringView() const { return s; }
  void AllocateSufficientStorage(size_t n) { s.resize(n); }
  void SetLength(size_t n) { s.resize(n); }
  char* out() { return s.data(); }
};
}
