#include "PlotJuggler/dataloader_base.h"
#include <QDebug>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QtPlugin>
#include <QTextCodec>
#include <cmath>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#define MCAP_IMPLEMENTATION
#include <mcap/reader.hpp>

namespace {
struct Slice {
  const uint8_t* data;
  size_t size;
};

bool varint(Slice input, size_t& offset, uint64_t& value) {
  value = 0;
  for (unsigned shift = 0; shift < 64 && offset < input.size; shift += 7) {
    const uint8_t byte = input.data[offset++];
    value |= uint64_t(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return true;
  }
  return false;
}

bool field(Slice input, size_t& offset, uint32_t& number, uint32_t& wire,
           uint64_t& integer, Slice& bytes) {
  uint64_t tag = 0;
  if (!varint(input, offset, tag) || !tag || tag >> 3 > UINT32_MAX) return false;
  number = uint32_t(tag >> 3);
  wire = uint32_t(tag & 7);
  bytes = {nullptr, 0};
  integer = 0;
  if (wire == 0) return varint(input, offset, integer);
  size_t length = 0;
  if (wire == 1) length = 8;
  else if (wire == 5) length = 4;
  else if (wire == 2) {
    uint64_t count = 0;
    if (!varint(input, offset, count) || count > input.size - offset) return false;
    length = size_t(count);
  } else return false;
  if (length > input.size - offset) return false;
  bytes = {input.data + offset, length};
  offset += length;
  return true;
}

std::string string(Slice bytes) {
  return std::string(reinterpret_cast<const char*>(bytes.data), bytes.size);
}

// FileDescriptorSet -> first FileDescriptorProto -> first DescriptorProto.
std::map<uint32_t, std::string> names(Slice descriptor_set) {
  std::map<uint32_t, std::string> result;
  Slice file_bytes{nullptr, 0}, message_bytes{nullptr, 0};
  for (size_t pos = 0; pos < descriptor_set.size;) {
    uint32_t n, w; uint64_t v; Slice b;
    if (!field(descriptor_set, pos, n, w, v, b)) return result;
    if (n == 1 && w == 2) { file_bytes = b; break; }
  }
  for (size_t pos = 0; pos < file_bytes.size;) {
    uint32_t n, w; uint64_t v; Slice b;
    if (!field(file_bytes, pos, n, w, v, b)) return result;
    if (n == 4 && w == 2) { message_bytes = b; break; }
  }
  for (size_t pos = 0; pos < message_bytes.size;) {
    uint32_t n, w; uint64_t v; Slice b;
    if (!field(message_bytes, pos, n, w, v, b)) return result;
    if (n != 2 || w != 2) continue;
    std::string name;
    uint32_t number = 0;
    for (size_t part = 0; part < b.size;) {
      uint32_t fn, fw; uint64_t fv; Slice fb;
      if (!field(b, part, fn, fw, fv, fb)) break;
      if (fn == 1 && fw == 2) name = string(fb);
      if (fn == 3 && fw == 0 && fv <= UINT32_MAX) number = uint32_t(fv);
    }
    if (number && !name.empty()) result[number] = name;
  }
  return result;
}

size_t add_message(Slice payload, const std::map<uint32_t, std::string>& fields,
                   const std::string& topic, double time, PJ::PlotDataMapRef& output) {
  size_t added = 0;
  for (size_t pos = 0; pos < payload.size;) {
    uint32_t number, wire; uint64_t integer; Slice bytes;
    if (!field(payload, pos, number, wire, integer, bytes)) break;
    auto name = fields.find(number);
    if (name == fields.end()) continue;
    double value;
    if (wire == 0) value = double(integer);
    else if (wire == 1) { uint64_t raw; std::memcpy(&raw, bytes.data, 8); std::memcpy(&value, &raw, 8); }
    else if (wire == 5) { float sample; std::memcpy(&sample, bytes.data, 4); value = sample; }
    else continue;
    if (!std::isfinite(value)) continue;
    output.addNumeric(topic + "/" + name->second)->second.pushBack({time, value});
    ++added;
  }
  return added;
}

size_t add_json_value(const QString& path, const QJsonValue& value, double time,
                      PJ::PlotDataMapRef& output) {
  if (value.isDouble()) {
    const double number = value.toDouble();
    if (!std::isfinite(number)) return 0;
    output.addNumeric(path.toStdString())->second.pushBack({time, number});
    return 1;
  }
  size_t added = 0;
  if (value.isObject()) {
    const auto object = value.toObject();
    for (auto it = object.begin(); it != object.end(); ++it) {
      QString key = it.key();
      while (key.startsWith('/')) key.remove(0, 1);
      const QString child = path.isEmpty() ? key : path + '/' + key;
      added += add_json_value(child, it.value(), time, output);
    }
  } else if (value.isArray()) {
    const auto array = value.toArray();
    for (int i = 0; i < array.size(); ++i) {
      QString key = QString::number(i);
      if (path == "task_top/tasks" && array[i].isObject()) {
        const auto pid = array[i].toObject().value("pid");
        if (!pid.isDouble()) continue;
        key = "pid_" + QString::number(qint64(pid.toDouble()));
      }
      added += add_json_value(path + '/' + key, array[i], time, output);
    }
  }
  return added;
}

size_t add_json_message(Slice payload, double time, PJ::PlotDataMapRef& output) {
  QJsonParseError error;
  const auto document = QJsonDocument::fromJson(
      QByteArray(reinterpret_cast<const char*>(payload.data), int(payload.size)), &error);
  if (error.error != QJsonParseError::NoError || !document.isObject()) return 0;
  const auto object = document.object();
  size_t added = 0;
  for (auto it = object.begin(); it != object.end(); ++it) {
    const QString path = it.key() == "properties" ? QString() :
                         it.key() == "timestamp" ? QString("simulation/time_s") : it.key();
    added += add_json_value(path, it.value(), time, output);
  }
  const auto top = object.value("task_top").toObject();
  for (const auto& pair : {std::pair<const char*, const char*>("fdm_run_ms", "fdm/run_ms"),
                           {"fdm_avg_ms", "fdm/average_ms"},
                           {"fdm_max_ms", "fdm/max_ms"},
                           {"fdm_samples", "fdm/samples"}}) {
    added += add_json_value(pair.second, top.value(pair.first), time, output);
  }
  return added;
}

class ConsoleDecoder {
  std::unique_ptr<QTextDecoder> decoder;
  uint64_t next_offset = 0;
public:
  size_t add(Slice payload, double time, PJ::PlotDataMapRef& output) {
    const auto document = QJsonDocument::fromJson(
        QByteArray(reinterpret_cast<const char*>(payload.data), int(payload.size)));
    if (!document.isObject()) return 0;
    const auto object = document.object();
    const auto offset = uint64_t(object.value("offset").toDouble());
    if (!decoder || offset != next_offset)
      decoder.reset(QTextCodec::codecForName("UTF-8")->makeDecoder());
    const auto raw = QByteArray::fromHex(object.value("raw_hex").toString().toLatin1());
    next_offset = offset + uint64_t(raw.size());
    // Carry incomplete UTF-8 across batches; a byte gap resets the decoder.
    // The MCAP raw_hex field preserves invalid bytes as well as valid text.
    const auto text = decoder->toUnicode(raw).toUtf8();
    if (!text.isEmpty())
      output.addStringSeries("/jsbsim/console/text")->second.pushBack(
          std::pair<double, PJ::StringRef>{time, PJ::StringRef(text.constData(), size_t(text.size()))});
    return size_t(!text.isEmpty()) + add_json_value("/jsbsim/console", object, time, output);
  }
};
} // namespace

class JSBSimMcap : public PJ::DataLoader {
  Q_OBJECT
  Q_PLUGIN_METADATA(IID "facontidavide.PlotJuggler3.DataLoader")
  Q_INTERFACES(PJ::DataLoader)
public:
  const char* name() const override { return "JSBSim MCAP"; }
  const std::vector<const char*>& compatibleFileExtensions() const override {
    static const std::vector<const char*> extensions{"mcap"};
    return extensions;
  }
  bool readDataFromFile(PJ::FileLoadInfo* info, PJ::PlotDataMapRef& output) override {
    mcap::McapReader reader;
    auto status = reader.open(info->filename.toStdString());
    if (!status.ok()) throw std::runtime_error("MCAP open: " + status.message);
    // Board files have LZ4 chunks but no Summary section or message indexes.
    status = reader.readSummary(mcap::ReadSummaryMethod::ForceScan);
    if (!status.ok()) throw std::runtime_error("MCAP scan: " + status.message);
    std::map<uint16_t, std::map<uint32_t, std::string>> channel_fields;
    std::map<uint16_t, std::string> topics;
    std::set<uint16_t> json_channels;
    std::set<uint16_t> console_channels;
    const auto schemas = reader.schemas();
    for (const auto& [id, channel] : reader.channels()) {
      if (channel->schemaId == 0 && channel->messageEncoding == "json" &&
          (channel->topic == "/jsbsim/telemetry" || channel->topic == "/jsbsim/console")) {
        json_channels.insert(id);
        if (channel->topic == "/jsbsim/console") console_channels.insert(id);
        continue;
      }
      const auto schema = schemas.find(channel->schemaId);
      if (schema == schemas.end() || channel->messageEncoding != "protobuf" ||
          schema->second->encoding != "protobuf") continue;
      const auto& data = schema->second->data;
      auto fields = names({reinterpret_cast<const uint8_t*>(data.data()), data.size()});
      if (fields.empty()) continue;
      channel_fields[id] = std::move(fields);
      topics[id] = channel->topic.empty() ? "jsbsim" : channel->topic;
    }
    size_t messages = 0, samples = 0;
    ConsoleDecoder console;
    std::string problem;
    auto on_problem = [&](const mcap::Status& error) { problem = error.message; };
    for (const auto& view : reader.readMessages(on_problem)) {
      const auto channel = channel_fields.find(view.message.channelId);
      if (channel == channel_fields.end() &&
          !json_channels.count(view.message.channelId)) continue;
      ++messages;
      const Slice payload{reinterpret_cast<const uint8_t*>(view.message.data),
                          view.message.dataSize};
      const double time = double(view.message.publishTime) * 1e-9;
      if (console_channels.count(view.message.channelId))
        samples += console.add(payload, time, output);
      else if (channel == channel_fields.end())
        samples += add_json_message(payload, time, output);
      else
        samples += add_message(payload, channel->second,
                               topics.at(view.message.channelId), time, output);
    }
    if (!problem.empty()) throw std::runtime_error("MCAP messages: " + problem);
    qInfo() << "JSBSim MCAP loaded" << QFileInfo(info->filename).fileName()
            << "messages=" << messages << "samples=" << samples;
    return samples > 0;
  }
};

#include "jsbsim_mcap.moc"
