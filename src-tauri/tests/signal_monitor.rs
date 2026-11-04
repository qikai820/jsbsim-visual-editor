#[path = "../src/signal_monitor.rs"]
mod signal_monitor;

#[test]
fn subscription_packets_round_trip_header_and_paths() {
    let keys = vec!["fcs/esc-out[0]".to_string(), "_monitor/value/n0123456789abcdef".to_string()];
    let packets = signal_monitor::packets(32, 0x12345678, &keys).unwrap();
    for (index, packet) in packets.iter().enumerate() {
        assert_eq!(&packet[..4], b"VMON");
        assert_eq!(&packet[4..8], &[32, 2, index as u8, 0]);
        assert_eq!(&packet[8..12], &0x12345678u32.to_le_bytes());
        assert_eq!(&packet[12..], keys[index].as_bytes());
        assert!(packet.len() <= 160);
    }
}

#[test]
fn clear_is_an_explicit_empty_transaction() {
    assert_eq!(signal_monitor::packets(1, 9, &[]).unwrap()[0], [b"VMON".as_slice(), &[1, 0, 0, 0], &9u32.to_le_bytes()].concat());
}

#[test]
fn malformed_requests_are_rejected_before_transport() {
    for id in [0, 33] { assert!(signal_monitor::packets(id, 1, &[]).is_err()); }
    assert!(signal_monitor::packets(1, 0, &[]).is_err());
    assert!(signal_monitor::packets(1, 1, &vec!["a".into();33]).is_err());
    for key in ["a\nb", "a\0b", "../a", "a\"b"] { assert!(signal_monitor::packets(1, 1, &[key.into()]).is_err()); }
    assert!(signal_monitor::packets(1, 1, &["a".repeat(129)]).is_err());
}

#[test]
fn property_slices_are_delivered_between_auxiliary_frames() {
    use serde_json::json;
    let mut queue = signal_monitor::ObservationQueue::default();
    for (time, value) in [(1.0, 0.0), (1.05, 0.375), (1.1, 0.8)] {
        queue.push(&json!({"instance_id":"01","model":"voliro_t","state":"running","timestamp":time,
            "tree_generation":7,"tree_total":794,"tree_offset":160,"display_rate_hz":50,
            "properties":{"/01/jsbsim/fcs[0]/esc-out[1]":value}}));
        queue.push(&json!({"kind":"task_top","task_top":{"cpu_percent":25}}));
    }
    let batch = queue.drain(1);
    assert_eq!(batch.iter().map(|frame| frame["properties"]["/01/jsbsim/fcs[0]/esc-out[1]"].as_f64().unwrap()).collect::<Vec<_>>(), vec![0.0, 0.375, 0.8]);
    assert!(batch.iter().all(|frame| frame["age_ms"].as_u64().is_some() && frame["tree_total"] == 794 && frame["tree_generation"] == 7 && frame["display_rate_hz"] == 50));
    assert!(queue.drain(1).is_empty(), "polling cannot manufacture new samples");
}

#[test]
fn observations_are_bounded_and_isolated_by_instance() {
    use serde_json::json;
    let mut queue = signal_monitor::ObservationQueue::default();
    for time in 0..300 {
        queue.push(&json!({"instance_id":2,"model":"test","state":"running","timestamp":time,
            "monitor":{"version":1,"revision":9,"sequence":time,"samples":{"a":[0,time,false]}}}));
    }
    assert!(queue.drain(1).is_empty());
    let batch = queue.drain(2);
    assert_eq!(batch.len(), 256);
    assert_eq!(batch.first().unwrap()["timestamp"],44);
    assert_eq!(batch.last().unwrap()["timestamp"],299);
    assert!(batch.iter().all(|frame| frame["instance_id"] == "02" && frame["monitor"]["revision"] == 9));
}
