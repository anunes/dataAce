use tokio::net::TcpListener;

pub struct SshTunnel {
    pub local_port: u16,
    _child: tokio::process::Child,
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        let _ = self._child.start_kill();
    }
}

/// Creates an SSH tunnel via the system `ssh` binary (available on macOS, Linux, Windows 10+).
/// Returns the local port that forwards to target_host:target_port through the SSH server.
pub async fn create_ssh_tunnel(
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
    ssh_password: String,
    target_host: String,
    target_port: u16,
) -> Result<SshTunnel, String> {
    // Find a free local port first
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind local port: {}", e))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    drop(listener); // Release so ssh can use it

    let forward_arg = format!("{}:{}:{}", local_port, target_host, target_port);
    let destination = format!("{}@{}", ssh_user, ssh_host);

    // Build ssh command — use sshpass if password provided, else rely on key/agent
    let mut cmd = if !ssh_password.is_empty() {
        let mut c = tokio::process::Command::new("sshpass");
        c.args(["-p", &ssh_password]);
        c.arg("ssh");
        c
    } else {
        tokio::process::Command::new("ssh")
    };

    cmd.args([
        "-N",
        "-o", "StrictHostKeyChecking=no",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-L", &forward_arg,
        "-p", &ssh_port.to_string(),
        &destination,
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {}. Make sure ssh is installed.", e))?;

    // Give the tunnel a moment to establish
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    Ok(SshTunnel {
        local_port,
        _child: child,
    })
}
