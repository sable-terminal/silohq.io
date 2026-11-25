//go:build windows

package discovery

import (
	"strings"
	"syscall"
	"unsafe"
)

// registryReferences reads the ODBC data sources Windows keeps in its registry, the machine's
// and the agent user's: each one's driver, server and port, nothing else.
func registryReferences() []reference {
	var refs []reference
	for _, root := range []syscall.Handle{syscall.HKEY_LOCAL_MACHINE, syscall.HKEY_CURRENT_USER} {
		refs = append(refs, odbcRegistry(root)...)
	}
	return refs
}

func odbcRegistry(root syscall.Handle) []reference {
	path, _ := syscall.UTF16PtrFromString(`SOFTWARE\ODBC\ODBC.INI`)
	var key syscall.Handle
	if syscall.RegOpenKeyEx(root, path, 0, syscall.KEY_READ, &key) != nil {
		return nil
	}
	defer syscall.RegCloseKey(key)
	var refs []reference
	for i := uint32(0); i < 1000; i++ {
		name := make([]uint16, 256)
		n := uint32(len(name))
		if syscall.RegEnumKeyEx(key, i, &name[0], &n, nil, nil, nil, nil) != nil {
			break
		}
		source := syscall.UTF16ToString(name[:n])
		if source == "ODBC Data Sources" {
			continue
		}
		subPath, _ := syscall.UTF16PtrFromString(source)
		var sub syscall.Handle
		if syscall.RegOpenKeyEx(key, subPath, 0, syscall.KEY_READ, &sub) != nil {
			continue
		}
		section := map[string]string{}
		for _, value := range []string{"Driver", "Server", "ServerName", "Host", "HostName", "Address", "Port"} {
			if s, ok := registryString(sub, value); ok {
				section[strings.ToLower(value)] = s
			}
		}
		_ = syscall.RegCloseKey(sub)
		if ref, ok := odbcSource(section); ok {
			refs = append(refs, ref)
		}
	}
	return refs
}

func registryString(key syscall.Handle, name string) (string, bool) {
	p, _ := syscall.UTF16PtrFromString(name)
	var kind, size uint32
	if syscall.RegQueryValueEx(key, p, nil, &kind, nil, &size) != nil || (kind != syscall.REG_SZ && kind != syscall.REG_EXPAND_SZ) || size < 2 || size > 4096 {
		return "", false
	}
	buf := make([]uint16, size/2+1)
	if syscall.RegQueryValueEx(key, p, nil, &kind, (*byte)(unsafe.Pointer(&buf[0])), &size) != nil {
		return "", false
	}
	return syscall.UTF16ToString(buf), true
}
