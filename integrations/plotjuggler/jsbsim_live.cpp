#include "PlotJuggler/datastreamer_base.h"
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QNetworkDatagram>
#include <QUdpSocket>
#include <QSaveFile>
#include <QTimer>
#include <QApplication>
#include <QMainWindow>
#include <QSpinBox>
#include <QFileInfo>
#include <algorithm>
#include <cmath>

// Dedicated loopback receiver. No board connection or control commands.
class JSBSimLive : public PJ::DataStreamer
{
  Q_OBJECT
  Q_PLUGIN_METADATA(IID "facontidavide.PlotJuggler3.DataStreamer")
  Q_INTERFACES(PJ::DataStreamer)
public:
  const char* name() const override { return "JSBSim Live"; }
  bool isRunning() const override { return socket_ != nullptr; }
  ~JSBSimLive() override { shutdown(); }
  bool start(QStringList*) override
  {
    if (socket_) return true;
    bool ok = false;
    const auto port = qEnvironmentVariableIntValue("JSBSIM_PLOTJUGGLER_PORT", &ok);
    if (!ok || port < 1 || port > 65535) return false;
    socket_ = new QUdpSocket(this);
    if (!socket_->bind(QHostAddress::LocalHost, quint16(port)))
    {
      delete socket_;
      socket_ = nullptr;
      return false;
    }
    connect(socket_, &QUdpSocket::readyRead, this, [this] {
      while (socket_->hasPendingDatagrams())
      {
        const auto packet = socket_->receiveDatagram();
        if (!packet.senderAddress().isLoopback()) continue;
        const auto object = QJsonDocument::fromJson(packet.data()).object();
        const auto addSample = [this](const QJsonObject& sample) {
          if (!sample.value("time").isDouble() || !sample.value("values").isObject()) return;
          const double time = sample.value("time").toDouble();
          if (!std::isfinite(time)) return;
          const auto values = sample.value("values").toObject();
          for (auto it = values.begin(); it != values.end(); ++it)
          {
            if (it.value().isDouble() && std::isfinite(it.value().toDouble()))
            {
              dataMap().addNumeric(it.key().toStdString())->second.pushBack({time, it.value().toDouble()});
              ++samples_;
            }
          }
          ++received_;
        };
        std::lock_guard<std::mutex> guard(mutex());
        if (object.value("batch").isArray())
        {
          for (const auto& sample : object.value("batch").toArray())
            if (sample.isObject()) addSample(sample.toObject());
        }
        else addSample(object);
      }
      emit dataReceived();
    });
    timer_.setInterval(500);
    connect(&timer_, &QTimer::timeout, this, &JSBSimLive::report, Qt::UniqueConnection);
    timer_.start();
    // The command-line buffer option sets only the maximum. PlotJuggler's
    // default is five seconds, which would discard the replayed history.
    for (auto widget : QApplication::topLevelWidgets())
      if (auto spin = widget->findChild<QSpinBox*>("streamingSpinBox"))
        spin->setValue(std::max(spin->value(), std::min(299, spin->maximum() - 1)));
    report();
    return true;
  }
  void shutdown() override
  {
    timer_.stop();
    delete socket_;
    socket_ = nullptr;
    report();
  }
private:
  void report()
  {
    const auto path = qEnvironmentVariable("JSBSIM_PLOTJUGGLER_STATUS");
    if (path.isEmpty()) return;
    const auto focus = QFileInfo(path).path() + "/" + QFileInfo(path).completeBaseName() + ".focus";
    if (QFile::remove(focus))
    {
      for (auto widget : QApplication::topLevelWidgets())
        if (qobject_cast<QMainWindow*>(widget)) { widget->showNormal(); widget->raise(); widget->activateWindow(); }
    }
    QSaveFile file(path);
    if (file.open(QIODevice::WriteOnly))
    {
      QJsonObject status{{"ready", isRunning()}, {"received", double(received_)},
                         {"samples", double(samples_)}, {"series", double(dataMap().numeric.size())}};
      for (auto widget : QApplication::topLevelWidgets())
        if (auto spin = widget->findChild<QSpinBox*>("streamingSpinBox"))
          status.insert("buffer_seconds", spin->value());
      file.write(QJsonDocument(status).toJson(QJsonDocument::Compact));
      file.commit();
    }
  }
  QUdpSocket* socket_ = nullptr;
  QTimer timer_;
  quint64 received_ = 0;
  quint64 samples_ = 0;
};
#include "jsbsim_live.moc"
