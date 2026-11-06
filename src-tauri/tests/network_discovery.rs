#[path = "../src/network_discovery.rs"] mod network_discovery;
#[path = "../src/romfs_network.rs"] mod romfs_network;

mod transport {
    pub fn network_host() -> Option<std::net::Ipv4Addr> {
        panic!("a discovery probe must use its candidate without resolving again")
    }
}

#[test]
fn recognizes_builtin_library_without_an_sd_directory() {
    use std::io::{BufRead, BufReader, Write};
    use std::net::{Ipv4Addr, TcpListener};
    use std::time::Duration;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    std::env::set_var("NSH_TELNET_PORT", listener.local_addr().unwrap().port().to_string());
    let board = std::thread::spawn(move || {
        for listing in [
            "/romfs/jsbsim:\n\r aircraft/\n\r engine/\n\r systems/\n\r",
            "nsh: ls: stat failed: 2\n\r",
            "/romfs/jsbsim:\n\r unrelated/\n\r",
        ] {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            stream.write_all(b"\n\rNuttShell (NSH)\n\rnsh> \x1b[K").unwrap();
            let mut command = String::new();
            reader.read_line(&mut command).unwrap();
            assert_eq!(command, "ls /romfs/jsbsim\n");
            write!(stream, "\x1b[K{listing}nsh> \x1b[K").unwrap();
            command.clear();
            reader.read_line(&mut command).unwrap();
            assert_eq!(command, "exit\n", "discovery must close NSH cleanly");
        }
    });

    assert!(romfs_network::verify_library(Ipv4Addr::LOCALHOST));
    assert!(!romfs_network::verify_library(Ipv4Addr::LOCALHOST));
    assert!(!romfs_network::verify_library(Ipv4Addr::LOCALHOST));
    board.join().unwrap();
    std::env::remove_var("NSH_TELNET_PORT");
}
