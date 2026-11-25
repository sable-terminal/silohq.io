package discovery

import (
	"bufio"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

// Host configuration (spec 19.2) reads this host's own files for the systems they name: ODBC
// data sources, connection strings, mounted shares, and scheduled jobs that reach systems. It
// takes from each only which system it names, where, and what it appears to be; never a user
// name, password, database name, path or command. A system is reported only when it is one of
// the authorisation's targets: what a file names is not authorised by being named.

// reference is a system a file names.
type reference struct {
	host     string
	port     int
	product  string
	protocol string
	dialect  string
}

// maxConfigBytes bounds what one file read takes.
const maxConfigBytes = 1 << 20

// configFiles are the files host configuration reads on this platform, then the host's own.
func configFiles(extra []string) []string {
	var files []string
	if runtime.GOOS != "windows" {
		files = append(files, "/etc/odbc.ini", "/usr/local/etc/odbc.ini", "/etc/crontab", "/etc/environment", "/proc/mounts", "/etc/fstab")
		if home, err := os.UserHomeDir(); err == nil {
			files = append(files, filepath.Join(home, ".odbc.ini"))
		}
		if env := os.Getenv("ODBCINI"); env != "" {
			files = append(files, env)
		}
		for _, dir := range []string{"/etc/cron.d", "/var/spool/cron/crontabs", "/var/spool/cron"} {
			entries, _ := os.ReadDir(dir)
			for _, e := range entries {
				if e.Type().IsRegular() {
					files = append(files, filepath.Join(dir, e.Name()))
				}
			}
		}
	}
	return append(files, extra...)
}

// hostConfig reads the files and reports each system within the targets, once.
func (r *run) hostConfig() {
	var refs []reference
	for _, path := range configFiles(r.settings.ConfigPaths) {
		refs = append(refs, readReferences(path)...)
	}
	refs = append(refs, registryReferences()...)
	r.settings.Logger.Info("host configuration read", "event", "agent.discovery_host_config", "systems_named", len(refs))
	seen := map[string]bool{}
	sort.SliceStable(refs, func(i, j int) bool { return refs[i].host < refs[j].host })
	for _, ref := range refs {
		if !r.going() {
			return
		}
		host, ok := r.targets.Match(r.ctx, ref.host, r.settings.Resolve)
		key := host + ":" + strconv.Itoa(ref.port)
		if !ok || seen[key] || !r.bound.admit(host) {
			continue
		}
		seen[key] = true
		if !r.probe(host, ref.port, MethodHostConfig, Identified) {
			return
		}
		if !r.finding(host, MethodHostConfig, service(ref.port, ref.product, "", ref.protocol, ref.dialect)) {
			return
		}
	}
}

func readReferences(path string) []reference {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maxConfigBytes))
	if err != nil {
		return nil
	}
	content := string(raw)
	var refs []reference
	switch {
	case strings.HasSuffix(path, "odbc.ini") || strings.HasSuffix(path, ".odbc.ini"):
		refs = append(refs, odbcReferences(content)...)
	case path == "/proc/mounts" || path == "/etc/fstab":
		refs = append(refs, mountReferences(content)...)
	}
	return append(refs, urlReferences(content)...)
}

// odbcReferences reads ini sections: each data source's driver, server and port.
func odbcReferences(content string) []reference {
	var refs []reference
	section := map[string]string{}
	flush := func() {
		if ref, ok := odbcSource(section); ok {
			refs = append(refs, ref)
		}
		section = map[string]string{}
	}
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch {
		case line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "#"):
		case strings.HasPrefix(line, "["):
			flush()
		default:
			key, value, ok := strings.Cut(line, "=")
			if ok {
				section[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(value)
			}
		}
	}
	flush()
	return refs
}

// odbcSource is the system one data source names (its keys lower-cased): the driver, the
// server and the port, nothing else.
func odbcSource(section map[string]string) (reference, bool) {
	host := firstOf(section, "server", "servername", "host", "hostname", "address")
	if host == "" {
		return reference{}, false
	}
	port := section["port"]
	host = strings.TrimPrefix(host, "tcp:")
	// SQL Server's host,port.
	if h, p, ok := strings.Cut(host, ","); ok {
		host, port = h, strings.TrimSpace(p)
	} else if h, p, err := net.SplitHostPort(host); err == nil {
		host, port = h, p
	}
	// SQL Server's server\instance: the host is before the instance.
	host = strings.SplitN(host, "\\", 2)[0]
	product, protocol, dialect, fallback := driverProduct(section["driver"])
	ref := reference{host: host, port: fallback, product: product, protocol: protocol, dialect: dialect}
	if p, err := strconv.Atoi(port); err == nil && p > 0 && p < 65536 {
		ref.port = p
	}
	return ref, true
}

func firstOf(m map[string]string, keys ...string) string {
	for _, k := range keys {
		if v := m[k]; v != "" {
			return v
		}
	}
	return ""
}

// driverProduct is what an ODBC driver's name or library says the system is.
func driverProduct(driver string) (product, protocol, dialect string, port int) {
	d := strings.ToLower(driver)
	switch {
	case strings.Contains(d, "postgres") || strings.Contains(d, "psqlodbc"):
		return "PostgreSQL", "sql", "postgres", 5432
	case strings.Contains(d, "maria"):
		return "MariaDB", "sql", "mysql", 3306
	case strings.Contains(d, "mysql") || strings.Contains(d, "myodbc"):
		return "MySQL", "sql", "mysql", 3306
	case strings.Contains(d, "sql server") || strings.Contains(d, "msodbcsql") || strings.Contains(d, "freetds") || strings.Contains(d, "tdsodbc"):
		return "Microsoft SQL Server", "sql", "sqlserver", 1433
	case strings.Contains(d, "oracle") || strings.Contains(d, "sqora"):
		return "Oracle Database", "sql", "oracle", 1521
	case strings.Contains(d, "snowflake"):
		return "Snowflake", "sql", "snowflake", 443
	case strings.Contains(d, "db2"):
		return "IBM Db2", "sql", "", 50000
	}
	return "ODBC data source", "sql", "", 0
}

// mountReferences reads mount tables for network shares: SMB and NFS servers.
func mountReferences(content string) []reference {
	var refs []reference
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 3 || strings.HasPrefix(fields[0], "#") {
			continue
		}
		source, kind := fields[0], fields[2]
		switch {
		case kind == "cifs" || kind == "smb3" || kind == "smbfs":
			// //server/share
			host := strings.SplitN(strings.TrimPrefix(source, "//"), "/", 2)[0]
			refs = append(refs, reference{host: host, port: 445, product: "SMB share", protocol: "other"})
		case strings.HasPrefix(kind, "nfs"):
			// server:/export
			host, _, ok := strings.Cut(source, ":")
			if ok {
				refs = append(refs, reference{host: strings.Trim(host, "[]"), port: 2049, product: "NFS export", protocol: "other"})
			}
		}
	}
	return refs
}

// connectionURL finds URLs that name systems: database, JDBC, message and file transfer URLs.
var connectionURL = regexp.MustCompile(`(?i)\b(?:jdbc:)?(postgres(?:ql)?|mysql|mariadb|sqlserver|mssql|oracle:thin:@|mongodb(?:\+srv)?|redis|amqps?|mqtts?|sftp|ftp|opc\.tcp|https?)://([^\s'"<>]+)`)

// urlReferences is each system a connection URL names: its scheme's product, host and port only.
func urlReferences(content string) []reference {
	var refs []reference
	for _, m := range connectionURL.FindAllStringSubmatch(content, 200) {
		scheme := strings.ToLower(m[1])
		u, err := url.Parse("x://" + m[2])
		if err != nil || u.Hostname() == "" {
			continue
		}
		ref := reference{host: u.Hostname()}
		switch scheme {
		case "postgres", "postgresql":
			ref.product, ref.protocol, ref.dialect, ref.port = "PostgreSQL", "sql", "postgres", portOf(u, 5432)
		case "mysql", "mariadb":
			ref.product, ref.protocol, ref.dialect, ref.port = "MySQL", "sql", "mysql", portOf(u, 3306)
		case "sqlserver", "mssql":
			ref.product, ref.protocol, ref.dialect, ref.port = "Microsoft SQL Server", "sql", "sqlserver", portOf(u, 1433)
		case "oracle:thin:@":
			ref.product, ref.protocol, ref.dialect, ref.port = "Oracle Database", "sql", "oracle", portOf(u, 1521)
		case "mongodb", "mongodb+srv":
			ref.product, ref.protocol, ref.port = "MongoDB", "other", portOf(u, 27017)
		case "redis":
			ref.product, ref.protocol, ref.port = "Redis", "other", portOf(u, 6379)
		case "amqp", "amqps":
			ref.product, ref.protocol, ref.port = "AMQP broker", "other", portOf(u, 5672)
		case "mqtt", "mqtts":
			ref.product, ref.protocol, ref.port = "MQTT broker", "mqtt", portOf(u, 1883)
		case "opc.tcp":
			ref.product, ref.protocol, ref.port = "OPC UA server", "opc_ua", portOf(u, 4840)
		case "sftp":
			ref.product, ref.protocol, ref.port = "SFTP server", "sftp", portOf(u, 22)
		case "ftp":
			ref.product, ref.protocol, ref.port = "FTP server", "other", portOf(u, 21)
		default:
			ref.product, ref.protocol = "HTTP service", "rest"
			ref.port = portOf(u, map[string]int{"http": 80, "https": 443}[scheme])
		}
		refs = append(refs, ref)
	}
	return refs
}
