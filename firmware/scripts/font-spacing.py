"""Shared packing-time Terminus spacing; original bitmap rows stay untouched.

Both the main atlas and life subset call this function. Runtime bounds, drawing,
circle fitting and line breaking therefore consume exactly the same metrics.
"""
POLICY={
    'space':'U+0020: round-half-up(native advance / 2)',
    'middleDot':'U+00B7: ink width + 4 advance, ink centred with 2px on each side',
}

def terminus_spacing(code,glyph):
    advance,left,top,width,height,bits=glyph
    if code==0x20:
        advance=(advance+1)//2
    elif code==0xb7:
        columns=[x for y in range(height) for x in range(width)
                 if bits[y*((width+7)//8)+x//8]&(128>>(x%8))]
        if not columns:raise ValueError('Middle dot must have native ink')
        advance=max(columns)-min(columns)+5
        left=2-min(columns)
    return advance,left,top,width,height,bits
