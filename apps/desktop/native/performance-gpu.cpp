// One read of adapter-wide WDDM counters. No graphics context or process enumeration.
#include <windows.h>
#include <d3dkmthk.h>
#include <cstdio>
#include <cwchar>

template<class T>
static bool adapterInfo(D3DKMT_HANDLE handle, KMTQUERYADAPTERINFOTYPE type, T &value) {
    D3DKMT_QUERYADAPTERINFO query{};
    query.hAdapter = handle;
    query.Type = type;
    query.pPrivateDriverData = &value;
    query.PrivateDriverDataSize = sizeof(value);
    return D3DKMTQueryAdapterInfo(&query) >= 0;
}

static void jsonName(const wchar_t *name) {
    char utf8[1024]{};
    WideCharToMultiByte(CP_UTF8, 0, name, -1, utf8, sizeof(utf8), nullptr, nullptr);
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)utf8; *p; ++p) {
        if (*p == '"' || *p == '\\') putchar('\\');
        if (*p >= 32) putchar(*p);
    }
    putchar('"');
}

int main() {
    D3DKMT_ADAPTERINFO adapters[32]{};
    D3DKMT_ENUMADAPTERS2 list{};
    list.NumAdapters = ARRAYSIZE(adapters);
    list.pAdapters = adapters;
    if (D3DKMTEnumAdapters2(&list) < 0) return 1;
    bool firstAdapter = true;
    putchar('[');
    for (UINT index = 0; index < list.NumAdapters; ++index) {
        const auto adapter = adapters[index];
        D3DKMT_ADAPTERTYPE type{};
        D3DKMT_ADAPTERREGISTRYINFO registry{};
        D3DKMT_SEGMENTSIZEINFO memory{};
        if (!adapterInfo(adapter.hAdapter, KMTQAITYPE_ADAPTERTYPE, type) || type.SoftwareDevice || !type.RenderSupported) continue;
        adapterInfo(adapter.hAdapter, KMTQAITYPE_ADAPTERREGISTRYINFO, registry);
        adapterInfo(adapter.hAdapter, KMTQAITYPE_GETSEGMENTSIZE, memory);
        const ULONGLONG capacity = memory.DedicatedVideoMemorySize;
        D3DKMT_QUERYSTATISTICS stats{};
        stats.Type = D3DKMT_QUERYSTATISTICS_ADAPTER;
        stats.AdapterLuid = adapter.AdapterLuid;
        if (D3DKMTQueryStatistics(&stats) >= 0) {
            const auto info = stats.QueryResult.AdapterInformation;
            ULONGLONG resident = 0;
            bool validMemory = info.NbSegments > 0 && info.NbSegments <= 256 && capacity > 0;
            for (ULONG i = 0; validMemory && i < info.NbSegments; ++i) {
                stats.Type = D3DKMT_QUERYSTATISTICS_SEGMENT;
                stats.QuerySegment.SegmentId = i;
                if (D3DKMTQueryStatistics(&stats) < 0) validMemory = false;
                else if (!stats.QueryResult.SegmentInformation.Aperture)
                    resident += stats.QueryResult.SegmentInformation.BytesResident;
            }
            if (!firstAdapter) putchar(',');
            firstAdapter = false;
            D3DKMT_ADAPTERADDRESS address{};
            if (adapterInfo(adapter.hAdapter, KMTQAITYPE_ADAPTERADDRESS, address))
                printf("{\"id\":\"pci-%02x:%02x.%x\",\"name\":", address.BusNumber, address.DeviceNumber, address.FunctionNumber);
            else printf("{\"id\":\"luid-%08lx%08lx\",\"name\":", (ULONG)adapter.AdapterLuid.HighPart, adapter.AdapterLuid.LowPart);
            jsonName(registry.AdapterString);
            printf(",\"total\":%llu,\"used\":", capacity);
            if (validMemory && resident <= capacity) printf("%llu", resident);
            else printf("null");
            printf(",\"nodes\":[");
            bool first = true;
            for (UINT i = 0; i < info.NodeCount && i < 256; ++i) {
                D3DKMT_NODEMETADATA meta{};
                meta.NodeOrdinalAndAdapterIndex = i;
                if (!adapterInfo(adapter.hAdapter, KMTQAITYPE_NODEMETADATA, meta)) continue;
                wchar_t label[DXGK_MAX_METADATA_NAME_LENGTH + 1]{};
                wcsncpy_s(label, meta.NodeData.FriendlyName, _TRUNCATE);
                _wcslwr_s(label);
                const char *kind = nullptr;
                if (wcsstr(label, L"cuda")) kind = "cuda";
                else if (wcsstr(label, L"compute")) kind = "compute";
                else if (meta.NodeData.EngineType == DXGK_ENGINE_TYPE_3D) kind = "3d";
                if (!kind) continue;
                stats.Type = D3DKMT_QUERYSTATISTICS_NODE;
                stats.QueryNode.NodeId = i;
                if (D3DKMTQueryStatistics(&stats) < 0) continue;
                printf("%s[%u,\"%s\",%lld]", first ? "" : ",", i, kind,
                       stats.QueryResult.NodeInformation.GlobalInformation.RunningTime.QuadPart);
                first = false;
            }
            printf("]}");
        }
    }
    for (UINT i = 0; i < list.NumAdapters; ++i) {
        D3DKMT_CLOSEADAPTER close{};
        close.hAdapter = adapters[i].hAdapter;
        D3DKMTCloseAdapter(&close);
    }
    puts("]");
    return 0;
}
