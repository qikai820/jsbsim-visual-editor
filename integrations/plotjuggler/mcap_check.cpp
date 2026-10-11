#define MCAP_IMPLEMENTATION
#include <mcap/reader.hpp>

#include <exception>
#include <iostream>

int main(int argc, char* argv[]) {
  if (argc != 2) {
    std::cerr << "usage: JSBSimMcapCheck FILE\n";
    return 2;
  }
  try {
    mcap::McapReader reader;
    auto status = reader.open(argv[1]);
    if (!status.ok()) throw std::runtime_error(status.message);
    status = reader.readSummary(mcap::ReadSummaryMethod::ForceScan);
    if (!status.ok()) throw std::runtime_error(status.message);
    size_t messages = 0;
    std::string problem;
    for (const auto& view : reader.readMessages([&](const mcap::Status& error) {
           problem = error.message;
         })) {
      (void)view;
      ++messages;
    }
    if (!problem.empty()) throw std::runtime_error(problem);
    if (messages == 0) throw std::runtime_error("MCAP contains no messages");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
