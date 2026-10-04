public enum HeightUnit: String, Codable, CaseIterable {
    case metres
    case feet

    public var perMetre: Double {
        switch self {
        case .metres: return 1
        case .feet: return 3.28084
        }
    }

    public var symbol: String {
        var suffix = self == .metres ? "m" : "ft"
        return suffix
    }
}
